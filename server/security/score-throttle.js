import { createFixedWindowLimiter } from './fixed-window-limiter.js';

export const SCORE_WINDOW_MS = 60_000;
export const SCORE_SUBMISSION_LIMIT = 12;

export function createScoreThrottle({ now = Date.now } = {}) {
  const limiter = createFixedWindowLimiter({
    limit: SCORE_SUBMISSION_LIMIT,
    windowMs: SCORE_WINDOW_MS,
    now,
  });

  function consumeSubmission(userId) {
    return limiter.consume(`user:${String(userId)}`);
  }

  return Object.freeze({ consumeSubmission });
}
