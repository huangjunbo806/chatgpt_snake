import { normalizeUsernameCandidate } from '../auth/auth-validation.js';
import { createFixedWindowLimiter } from './fixed-window-limiter.js';

export const REGISTRATION_WINDOW_MS = 60 * 60 * 1000;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const REGISTRATION_IP_LIMIT = 5;
const LOGIN_IP_LIMIT = 10;
const LOGIN_USERNAME_LIMIT = 5;

function ipKey(ip) {
  return `ip:${String(ip)}`;
}

function usernameKey(value) {
  const username = normalizeUsernameCandidate(value);
  return username === null ? null : `username:${username}`;
}

function loginResult(ipResult, usernameResult) {
  const ipBlocked = ipResult.blocked;
  const usernameBlocked = usernameResult?.blocked ?? false;

  return Object.freeze({
    blocked: ipBlocked || usernameBlocked,
    ipBlocked,
    usernameBlocked,
    retryAfterMs: Math.max(
      ipBlocked ? ipResult.retryAfterMs : 0,
      usernameBlocked ? usernameResult.retryAfterMs : 0,
    ),
  });
}

function loginAttemptResult(ipResult, usernameResult, reservation) {
  return Object.freeze({
    ...loginResult(ipResult, usernameResult),
    reservation,
  });
}

// 三个固定窗口 Map 都属于单进程内存状态；这里有意不内置 Redis 或跨进程同步。
export function createAuthThrottle({ now = Date.now } = {}) {
  const registrationIp = createFixedWindowLimiter({
    limit: REGISTRATION_IP_LIMIT,
    windowMs: REGISTRATION_WINDOW_MS,
    now,
  });
  const loginIp = createFixedWindowLimiter({
    limit: LOGIN_IP_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    now,
  });
  const loginUsername = createFixedWindowLimiter({
    limit: LOGIN_USERNAME_LIMIT,
    windowMs: LOGIN_WINDOW_MS,
    now,
  });
  const loginReservations = new WeakMap();

  function consumeRegistrationAttempt(ip) {
    return registrationIp.consume(ipKey(ip));
  }

  function beginLoginAttempt({ ip, username } = {}) {
    const normalizedUsernameKey = usernameKey(username);
    const ipReserved = loginIp.reserve(ipKey(ip));

    if (ipReserved.blocked) {
      const usernameChecked = normalizedUsernameKey === null
        ? null
        : loginUsername.check(normalizedUsernameKey);
      return loginAttemptResult(ipReserved, usernameChecked, null);
    }

    const usernameReserved = normalizedUsernameKey === null
      ? null
      : loginUsername.reserve(normalizedUsernameKey);
    if (usernameReserved?.blocked) {
      loginIp.release(ipReserved.reservation);
      return loginAttemptResult(ipReserved, usernameReserved, null);
    }

    const reservation = Object.freeze({});
    loginReservations.set(reservation, {
      ip: ipReserved.reservation,
      username: usernameReserved?.reservation ?? null,
      usernameKey: normalizedUsernameKey,
    });
    return loginAttemptResult(ipReserved, usernameReserved, reservation);
  }

  function takeLoginReservation(reservation) {
    const reserved = loginReservations.get(reservation);
    if (reserved) {
      loginReservations.delete(reservation);
    }
    return reserved;
  }

  function commitLoginFailure(reservation) {
    const reserved = takeLoginReservation(reservation);
    if (!reserved) {
      return;
    }
    loginIp.commit(reserved.ip);
    if (reserved.username !== null) {
      loginUsername.commit(reserved.username);
    }
  }

  function cancelLoginAttempt(reservation) {
    const reserved = takeLoginReservation(reservation);
    if (!reserved) {
      return;
    }
    loginIp.release(reserved.ip);
    if (reserved.username !== null) {
      loginUsername.release(reserved.username);
    }
  }

  function recordLoginSuccess({ username, reservation } = {}) {
    const reserved = takeLoginReservation(reservation);
    if (reserved) {
      loginIp.release(reserved.ip);
      if (reserved.username !== null) {
        loginUsername.release(reserved.username);
      }
    }

    const normalizedUsernameKey = usernameKey(username) ?? reserved?.usernameKey ?? null;
    if (normalizedUsernameKey !== null) {
      loginUsername.clearCommitted(normalizedUsernameKey);
    }
  }

  return Object.freeze({
    consumeRegistrationAttempt,
    beginLoginAttempt,
    commitLoginFailure,
    cancelLoginAttempt,
    recordLoginSuccess,
  });
}
