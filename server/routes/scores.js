import express from 'express';

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

export function createScoresRouter({ service, throttle } = {}) {
  const router = express.Router();

  router.post('/', requireAuth, async (req, res) => {
    const limit = throttle.consumeSubmission(req.session.userId);
    if (limit.blocked) {
      throw rateLimited(res, limit.retryAfterMs);
    }

    const result = await service.submit(req.session.userId, req.body);
    res.json({ data: result });
  });

  return router;
}
