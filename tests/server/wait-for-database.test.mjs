import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  DATABASE_WAIT_ATTEMPTS,
  DATABASE_WAIT_DELAY_MS,
  waitForDatabase,
} from '../../server/database/wait-for-database.js';

function createLogger() {
  const entries = [];
  return {
    entries,
    warn(...args) {
      entries.push(args);
    },
  };
}

describe('waitForDatabase', () => {
  test('第一次健康检查成功时立即返回，不等待也不记录失败', async () => {
    const calls = [];
    const logger = createLogger();

    const result = await waitForDatabase({
      healthCheck: async () => {
        calls.push('health');
        return true;
      },
      sleep: async (delayMs) => calls.push(`sleep:${delayMs}`),
      logger,
    });

    assert.equal(result, true);
    assert.deepEqual(calls, ['health']);
    assert.deepEqual(logger.entries, []);
    assert.equal(DATABASE_WAIT_ATTEMPTS, 30);
    assert.equal(DATABASE_WAIT_DELAY_MS, 2_000);
  });

  test('失败后按固定间隔重试，成功后不再等待', async () => {
    const logger = createLogger();
    const databaseUrl = 'postgresql://snake:retry-secret@db.example.test/snake';
    let attempts = 0;
    const sleeps = [];

    await waitForDatabase({
      healthCheck: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(`database unavailable: ${databaseUrl}`);
        }
        return true;
      },
      sleep: async (delayMs) => sleeps.push(delayMs),
      logger,
    });

    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [2_000, 2_000]);
    assert.deepEqual(logger.entries, [
      [{ event: 'database_wait_retry', attempt: 1, maxAttempts: 30 }],
      [{ event: 'database_wait_retry', attempt: 2, maxAttempts: 30 }],
    ]);
    assert.doesNotMatch(inspect(logger.entries), /retry-secret|postgresql|unavailable/iu);
  });

  test('健康检查返回 false 也视为未就绪', async () => {
    let attempts = 0;

    await waitForDatabase({
      healthCheck: async () => {
        attempts += 1;
        return attempts === 2;
      },
      sleep: async () => {},
      logger: createLogger(),
      maxAttempts: 2,
      retryDelayMs: 7,
    });

    assert.equal(attempts, 2);
  });

  test('达到 30 次仍失败时仅等待 29 次，并以稳定错误保留最后 cause', async () => {
    const errors = Array.from({ length: 30 }, (_, index) => (
      new Error(`database-secret-${index + 1}`)
    ));
    const logger = createLogger();
    let attempts = 0;
    const sleeps = [];

    await assert.rejects(
      waitForDatabase({
        healthCheck: async () => {
          const error = errors[attempts];
          attempts += 1;
          throw error;
        },
        sleep: async (delayMs) => sleeps.push(delayMs),
        logger,
      }),
      (error) => {
        assert.equal(error.message, '数据库在启动等待期限内仍不可用');
        assert.equal(error.cause, errors.at(-1));
        assert.doesNotMatch(error.message, /database-secret/iu);
        return true;
      },
    );

    assert.equal(attempts, 30);
    assert.equal(sleeps.length, 29);
    assert.ok(sleeps.every((delayMs) => delayMs === 2_000));
    assert.equal(logger.entries.length, 30);
    assert.deepEqual(logger.entries.at(-1), [
      { event: 'database_wait_exhausted', attempt: 30, maxAttempts: 30 },
    ]);
    assert.doesNotMatch(inspect(logger.entries), /database-secret/iu);
  });

  test('日志器自身失败不会改变重试结果', async () => {
    let attempts = 0;
    const logger = {};
    Object.defineProperty(logger, 'warn', {
      get() {
        throw new Error('logger-secret');
      },
    });

    await assert.doesNotReject(waitForDatabase({
      healthCheck: async () => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('database-secret');
        }
        return true;
      },
      sleep: async () => {},
      logger,
      maxAttempts: 2,
    }));
  });

  test('拒绝缺失的健康检查和无效测试参数', async () => {
    await assert.rejects(waitForDatabase(), /waitForDatabase.*healthCheck/u);
    await assert.rejects(
      waitForDatabase({ healthCheck: async () => true, maxAttempts: 0 }),
      /maxAttempts/u,
    );
    await assert.rejects(
      waitForDatabase({ healthCheck: async () => true, retryDelayMs: -1 }),
      /retryDelayMs/u,
    );
  });
});
