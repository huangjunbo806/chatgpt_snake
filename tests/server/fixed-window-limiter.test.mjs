import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createFixedWindowLimiter } from '../../server/security/fixed-window-limiter.js';

describe('固定窗口限流器', () => {
  test('check 不消费，consume 在限额后的下一次阻止并给出剩余时间', () => {
    let currentTime = 1_000;
    const limiter = createFixedWindowLimiter({
      limit: 2,
      windowMs: 1_000,
      now: () => currentTime,
    });

    assert.equal(Object.isFrozen(limiter), true);
    assert.deepEqual(limiter.check('client-a'), {
      blocked: false,
      remaining: 2,
      retryAfterMs: 0,
    });
    assert.deepEqual(limiter.consume('client-a'), {
      blocked: false,
      remaining: 1,
      retryAfterMs: 0,
    });
    assert.deepEqual(limiter.recordFailure('client-a'), {
      blocked: false,
      remaining: 0,
      retryAfterMs: 0,
    });
    assert.deepEqual(limiter.consume('client-a'), {
      blocked: true,
      remaining: 0,
      retryAfterMs: 1_000,
    });

    currentTime = 1_999;
    assert.equal(limiter.check('client-a').retryAfterMs, 1);
  });

  test('键彼此隔离，reset 只清指定键', () => {
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 500, now: () => 10 });

    limiter.consume('a');
    assert.equal(limiter.check('a').blocked, true);
    assert.equal(limiter.check('b').blocked, false);

    limiter.reset('a');
    assert.equal(limiter.check('a').blocked, false);
  });

  test('reserve 立即占用配额，release 只撤销本次预留而 commit 保留计数', () => {
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 500, now: () => 10 });

    const first = limiter.reserve('a');
    const second = limiter.reserve('a');
    assert.equal(first.blocked, false);
    assert.equal(second.blocked, false);
    assert.ok(first.reservation);
    assert.equal(limiter.reserve('a').blocked, true);

    limiter.release(first.reservation);
    const replacement = limiter.reserve('a');
    assert.equal(replacement.blocked, false);
    limiter.commit(second.reservation);
    limiter.release(second.reservation);
    limiter.release(replacement.reservation);

    assert.deepEqual(limiter.check('a'), {
      blocked: false,
      remaining: 1,
      retryAfterMs: 0,
    });
  });

  test('到达窗口边界恢复，并在普通操作中机会式清理过期键', () => {
    let currentTime = 0;
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 100, now: () => currentTime });

    for (let index = 0; index < 20; index += 1) {
      limiter.consume(`expired-${index}`);
    }
    currentTime = 100;

    assert.deepEqual(limiter.check('expired-0'), {
      blocked: false,
      remaining: 1,
      retryAfterMs: 0,
    });
    assert.equal(limiter.consume('expired-0').blocked, false);
  });

  test('拒绝无效 limit/windowMs，避免永不恢复的窗口', () => {
    for (const options of [
      { limit: 0, windowMs: 1 },
      { limit: 1.5, windowMs: 1 },
      { limit: 1, windowMs: 0 },
      { limit: 1, windowMs: Number.POSITIVE_INFINITY },
    ]) {
      assert.throws(() => createFixedWindowLimiter(options), /limit|windowMs/u);
    }
  });
});
