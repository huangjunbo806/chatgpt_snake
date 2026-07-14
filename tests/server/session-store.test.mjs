import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import { createPostgresSessionStore } from '../../server/database/session-store.js';

class RecordingStore {
  static options = [];

  constructor(options) {
    this.options = options;
    RecordingStore.options.push(options);
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

describe('createPostgresSessionStore', () => {
  test('用固定安全配置和同一 pool 构造 Store', () => {
    RecordingStore.options.length = 0;
    const pool = { identity: 'database-pool' };
    const store = createPostgresSessionStore({ pool, StoreClass: RecordingStore });

    assert.ok(store instanceof RecordingStore);
    assert.equal(store.options.pool, pool);
    assert.equal(store.options.schemaName, 'public');
    assert.equal(store.options.tableName, 'user_sessions');
    assert.equal(store.options.createTableIfMissing, false);
    assert.equal(store.options.disableTouch, true);
    assert.equal(store.options.pruneSessionInterval, 900);
    assert.equal(typeof store.options.errorLog, 'function');
    assert.deepEqual(Object.keys(store.options).sort(), [
      'createTableIfMissing',
      'disableTouch',
      'errorLog',
      'pool',
      'pruneSessionInterval',
      'schemaName',
      'tableName',
    ]);
    assert.equal(RecordingStore.options[0], store.options);
  });

  test('errorLog 丢弃原 Error、session 与连接信息', () => {
    const logger = createLogger();
    const pool = { connectionString: 'postgresql://snake:store-secret@db/snake_test' };
    const store = createPostgresSessionStore({
      pool,
      logger,
      StoreClass: RecordingStore,
    });

    store.options.errorLog(
      new Error('session-store-error-secret'),
      { sid: 'session-secret', pool },
    );

    assert.deepEqual(logger.entries, [[{ event: 'session_store_error' }]]);
    assert.doesNotMatch(
      inspect(logger.entries),
      /store-secret|session-store-error-secret|session-secret|postgresql|Error/u,
    );
  });

  test('日志器自身失败不会从 errorLog 抛出', () => {
    const store = createPostgresSessionStore({
      pool: {},
      logger: {
        error() {
          throw new Error('logger failed');
        },
      },
      StoreClass: RecordingStore,
    });

    assert.doesNotThrow(() => store.options.errorLog(new Error('database failed')));
  });

  test('日志方法 getter 抛错不会从 errorLog 传播', () => {
    const logger = {};
    Object.defineProperty(logger, 'error', {
      get() {
        throw new Error('logger-getter-secret');
      },
    });
    const store = createPostgresSessionStore({
      pool: {},
      logger,
      StoreClass: RecordingStore,
    });

    assert.doesNotThrow(() => store.options.errorLog(new Error('database failed')));
  });

  test('拒绝缺失的 pool', () => {
    assert.throws(
      () => createPostgresSessionStore({ StoreClass: RecordingStore }),
      /createPostgresSessionStore.*pool/u,
    );
  });
});
