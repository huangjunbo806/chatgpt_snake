import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  createDatabaseHealthCheck,
  createPool,
} from '../../server/database/pool.js';

class RecordingPool extends EventEmitter {
  static instances = [];

  constructor(options) {
    super();
    this.options = options;
    RecordingPool.instances.push(this);
  }
}

function createLogger() {
  const entries = [];
  return {
    entries,
    error(...args) {
      entries.push(args);
    },
  };
}

describe('createPool', () => {
  test('只把 databaseUrl 作为 connectionString 交给 Pool 实现', () => {
    RecordingPool.instances.length = 0;
    const databaseUrl = 'postgresql://snake:pool-secret@db.example.test/snake';

    const pool = createPool({ databaseUrl, PoolImpl: RecordingPool });

    assert.equal(pool, RecordingPool.instances[0]);
    assert.deepEqual(pool.options, { connectionString: databaseUrl });
  });

  test('拒绝缺失的 databaseUrl 并给出中文错误', () => {
    assert.throws(
      () => createPool({ PoolImpl: RecordingPool }),
      /createPool.*databaseUrl.*不能为空/u,
    );
  });

  test('空闲连接 error 事件只记录受控 event', () => {
    const logger = createLogger();
    const databaseUrl = 'postgresql://snake:pool-secret@db.example.test/snake';
    const pool = createPool({ databaseUrl, PoolImpl: RecordingPool, logger });

    pool.emit('error', new Error(`connection failed: ${databaseUrl}`));

    assert.deepEqual(logger.entries, [[{ event: 'database_pool_idle_error' }]]);
    assert.doesNotMatch(inspect(logger.entries), /pool-secret|connection failed|Error/u);
  });

  test('日志方法 getter 抛错时空闲连接 handler 不继续传播', () => {
    const logger = {};
    Object.defineProperty(logger, 'error', {
      get() {
        throw new Error('logger-getter-secret');
      },
    });
    const pool = createPool({
      databaseUrl: 'postgresql://snake:pool-secret@db.example.test/snake',
      PoolImpl: RecordingPool,
      logger,
    });

    assert.doesNotThrow(() => pool.emit('error', new Error('database-secret')));
  });
});

describe('createDatabaseHealthCheck', () => {
  test('执行固定 SELECT 1 并在成功时返回 true', async () => {
    const calls = [];
    const healthCheck = createDatabaseHealthCheck({
      pool: {
        async query(...args) {
          calls.push(args);
          return { rows: [{ '?column?': 1 }] };
        },
      },
    });

    assert.equal(await healthCheck(), true);
    assert.deepEqual(calls, [['SELECT 1']]);
  });

  test('保留数据库错误身份并向上抛出', async () => {
    const databaseError = new Error('database health secret');
    const healthCheck = createDatabaseHealthCheck({
      pool: {
        async query() {
          throw databaseError;
        },
      },
    });

    await assert.rejects(healthCheck, (error) => error === databaseError);
  });

  test('拒绝缺失的 pool', () => {
    assert.throws(
      () => createDatabaseHealthCheck(),
      /createDatabaseHealthCheck.*pool/u,
    );
  });
});
