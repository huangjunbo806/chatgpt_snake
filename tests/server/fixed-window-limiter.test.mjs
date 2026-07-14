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

  test('clearCommitted 只清已提交失败，保留 pending 且其后 commit 重新累计', () => {
    const limiter = createFixedWindowLimiter({ limit: 5, windowMs: 500, now: () => 10 });

    limiter.consume('a');
    limiter.consume('a');
    const pending = limiter.reserve('a');
    limiter.clearCommitted('a');

    assert.deepEqual(limiter.check('a'), {
      blocked: false,
      remaining: 4,
      retryAfterMs: 0,
    });
    limiter.commit(pending.reservation);
    assert.deepEqual(limiter.check('a'), {
      blocked: false,
      remaining: 4,
      retryAfterMs: 0,
    });
  });

  test('过期 reservation 的 commit/release 不影响新窗口 entry', () => {
    let currentTime = 0;
    const limiter = createFixedWindowLimiter({ limit: 3, windowMs: 100, now: () => currentTime });
    const expiredCommit = limiter.reserve('a');
    const expiredRelease = limiter.reserve('a');

    currentTime = 100;
    const current = limiter.reserve('a');
    limiter.commit(expiredCommit.reservation);
    limiter.release(expiredRelease.reservation);

    assert.deepEqual(limiter.check('a'), {
      blocked: false,
      remaining: 2,
      retryAfterMs: 0,
    });
    limiter.commit(current.reservation);
    assert.equal(limiter.check('a').remaining, 2);
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

  test('容量满时新键失败关闭且不逐出活动桶，过期后增量清理释放容量', () => {
    let currentTime = 0;
    const limiter = createFixedWindowLimiter({
      limit: 2,
      windowMs: 100,
      maxEntries: 3,
      cleanupBudget: 1,
      now: () => currentTime,
    });

    for (const key of ['active-a', 'active-b', 'active-c']) {
      assert.equal(limiter.consume(key).blocked, false);
    }

    assert.deepEqual(limiter.consume('overflow'), {
      blocked: true,
      remaining: 0,
      retryAfterMs: 100,
    });
    assert.equal(limiter.consume('active-a').blocked, false);
    assert.equal(limiter.consume('active-a').blocked, true);

    currentTime = 100;
    assert.equal(limiter.consume('after-expiry').blocked, false);
  });

  test('拒绝无效 limit/windowMs，避免永不恢复的窗口', () => {
    for (const options of [
      { limit: 0, windowMs: 1 },
      { limit: 1.5, windowMs: 1 },
      { limit: 1, windowMs: 0 },
      { limit: 1, windowMs: Number.POSITIVE_INFINITY },
      { limit: 1, windowMs: 1, maxEntries: 0 },
      { limit: 1, windowMs: 1, cleanupBudget: 1.5 },
    ]) {
      assert.throws(() => createFixedWindowLimiter(options), /limit|windowMs|maxEntries|cleanupBudget/u);
    }
  });
});
