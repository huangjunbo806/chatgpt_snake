import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  SCORE_SUBMISSION_LIMIT,
  SCORE_WINDOW_MS,
  createScoreThrottle,
} from '../../server/security/score-throttle.js';

describe('分数提交限流器', () => {
  test('每用户每分钟允许十二次，第十三次返回重试时间', () => {
    const throttle = createScoreThrottle({ now: () => 5_000 });

    assert.equal(Object.isFrozen(throttle), true);
    assert.deepEqual(Object.keys(throttle), ['consumeSubmission']);
    assert.equal(SCORE_SUBMISSION_LIMIT, 12);
    assert.equal(SCORE_WINDOW_MS, 60_000);
    for (let attempt = 1; attempt <= SCORE_SUBMISSION_LIMIT; attempt += 1) {
      assert.deepEqual(throttle.consumeSubmission('7'), {
        blocked: false,
        remaining: SCORE_SUBMISSION_LIMIT - attempt,
        retryAfterMs: 0,
      });
    }

    assert.deepEqual(throttle.consumeSubmission('7'), {
      blocked: true,
      remaining: 0,
      retryAfterMs: SCORE_WINDOW_MS,
    });
  });

  test('不同用户键完全隔离，不使用 IP 或 Session ID', () => {
    const throttle = createScoreThrottle({ now: () => 0 });

    for (let attempt = 0; attempt < SCORE_SUBMISSION_LIMIT; attempt += 1) {
      assert.equal(throttle.consumeSubmission('same-user').blocked, false);
    }
    assert.equal(throttle.consumeSubmission('same-user').blocked, true);
    assert.equal(throttle.consumeSubmission('other-user').blocked, false);
  });

  test('固定窗口中返回剩余重试时间，到边界立即恢复', () => {
    let currentTime = 100;
    const throttle = createScoreThrottle({ now: () => currentTime });

    for (let attempt = 0; attempt < SCORE_SUBMISSION_LIMIT; attempt += 1) {
      throttle.consumeSubmission('7');
    }
    currentTime = 30_100;
    assert.equal(throttle.consumeSubmission('7').retryAfterMs, 30_000);

    currentTime = 60_100;
    assert.deepEqual(throttle.consumeSubmission('7'), {
      blocked: false,
      remaining: SCORE_SUBMISSION_LIMIT - 1,
      retryAfterMs: 0,
    });
  });

  test('内存容量已满时新用户 fail-closed，已有用户配额不被驱逐', () => {
    const throttle = createScoreThrottle({ now: () => 0 });

    for (let index = 0; index < 10_000; index += 1) {
      assert.equal(throttle.consumeSubmission(`user-${index}`).blocked, false);
    }

    assert.deepEqual(throttle.consumeSubmission('overflow-user'), {
      blocked: true,
      remaining: 0,
      retryAfterMs: SCORE_WINDOW_MS,
    });
    assert.equal(throttle.consumeSubmission('user-0').blocked, false);
  });
});
