import express from 'express';

import { normalizeUsernameCandidate } from '../auth/auth-validation.js';
import { defaultSessionOps } from '../auth/session.js';
import { AppError } from '../errors.js';
import { requireAuth } from '../middleware/require-auth.js';

function rateLimited(res, retryAfterMs) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  res.set('Retry-After', String(retryAfterSeconds));
  return new AppError({
    status: 429,
    code: 'RATE_LIMITED',
    message: '请求过于频繁，请稍后再试',
  });
}

function sendGuest(res) {
  res.json({ data: { authenticated: false, user: null } });
}

function sessionCookieIsSecure(req) {
  return req.session?.cookie?.secure === true;
}

export function createAuthRouter({
  authService,
  authThrottle,
  sessionOps = defaultSessionOps,
} = {}) {
  const router = express.Router();

  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  router.post('/register', async (req, res) => {
    const limit = authThrottle.consumeRegistrationAttempt(req.ip);
    if (limit.blocked) {
      throw rateLimited(res, limit.retryAfterMs);
    }

    const user = await authService.register(req.body);
    const secure = sessionCookieIsSecure(req);
    try {
      await sessionOps.establishLoginSession(req, user.id);
    } catch (error) {
      try {
        sessionOps.clearSessionCookie(res, { secure });
      } finally {
        throw error;
      }
    }
    res.status(201).json({ data: { user } });
  });

  router.post('/login', async (req, res) => {
    const username = normalizeUsernameCandidate(req.body?.username);
    const attempt = authThrottle.beginLoginAttempt({ ip: req.ip, username });
    if (attempt.blocked) {
      throw rateLimited(res, attempt.retryAfterMs);
    }

    let user;
    try {
      user = await authService.login(req.body);
    } catch (error) {
      if (error instanceof AppError && (error.status === 400 || error.status === 401)) {
        authThrottle.commitLoginFailure(attempt.reservation);
      } else {
        authThrottle.cancelLoginAttempt(attempt.reservation);
      }
      throw error;
    }

    const secure = sessionCookieIsSecure(req);
    try {
      await sessionOps.establishLoginSession(req, user.id);
    } catch (error) {
      authThrottle.cancelLoginAttempt(attempt.reservation);
      try {
        sessionOps.clearSessionCookie(res, { secure });
      } finally {
        throw error;
      }
    }
    authThrottle.recordLoginSuccess({ username, reservation: attempt.reservation });
    res.json({ data: { user } });
  });

  router.post('/logout', requireAuth, async (req, res) => {
    const secure = sessionCookieIsSecure(req);
    try {
      await sessionOps.destroySession(req);
    } finally {
      sessionOps.clearSessionCookie(res, { secure });
    }
    res.status(204).end();
  });

  router.get('/me', async (req, res) => {
    if (!req.session?.userId) {
      sendGuest(res);
      return;
    }

    const user = await authService.findCurrentUser(String(req.session.userId));
    if (user === null) {
      const secure = sessionCookieIsSecure(req);
      try {
        await sessionOps.destroySession(req);
      } finally {
        sessionOps.clearSessionCookie(res, { secure });
      }
      sendGuest(res);
      return;
    }

    res.json({ data: { authenticated: true, user } });
  });

  return router;
}
