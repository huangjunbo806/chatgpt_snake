import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assertSafeTestDatabaseUrl,
  closeTestPool,
  createTestPool,
  getTestDatabaseUrl,
  resetTestDatabase,
} from '../helpers/test-database.mjs';

class RecordingPool {
  static instances = [];

  constructor(options) {
    this.options = options;
    RecordingPool.instances.push(this);
  }
}

function createResetPool(databaseName, { failOnSql, failOnRollback = false } = {}) {
  const queries = [];
  const releaseArguments = [];
  const operationError = new Error('reset-operation-secret');
  const rollbackError = new Error('reset-rollback-secret');
  let releases = 0;
  let connectCalls = 0;
  const client = {
    async query(text) {
      queries.push(text);
      if (text === 'SELECT current_database() AS database_name') {
        return { rows: [{ database_name: databaseName }] };
      }
      if (text === failOnSql) {
        throw operationError;
      }
      if (text === 'ROLLBACK' && failOnRollback) {
        throw rollbackError;
      }
      return { rows: [] };
    },
    release(error) {
      releases += 1;
      releaseArguments.push(error);
    },
  };

  return {
    pool: {
      async connect() {
        connectCalls += 1;
        return client;
      },
    },
    queries,
    operationError,
    releaseArguments,
    rollbackError,
    get connectCalls() {
      return connectCalls;
    },
    get releases() {
      return releases;
    },
  };
}

describe('测试数据库 URL 安全边界', () => {
  test('只读取 TEST_DATABASE_URL，绝不回退到 DATABASE_URL', () => {
    const productionUrl = 'postgresql://snake:production-secret@db/snake';
    const testUrl = 'postgresql://snake:test-secret@db/snake_test';

    assert.equal(getTestDatabaseUrl({ DATABASE_URL: productionUrl }), null);
    assert.equal(getTestDatabaseUrl({
      DATABASE_URL: productionUrl,
      TEST_DATABASE_URL: testUrl,
    }), testUrl);
  });

  test('安全校验接受数据库名含 _test 或 -test 的 PostgreSQL URL', () => {
    assert.equal(
      assertSafeTestDatabaseUrl('postgresql://snake:secret@db/snake_test'),
      'postgresql://snake:secret@db/snake_test',
    );
    assert.equal(
      assertSafeTestDatabaseUrl('postgres://snake:secret@db/docker-snake-test?sslmode=require'),
      'postgres://snake:secret@db/docker-snake-test?sslmode=require',
    );
  });

  test('拒绝非测试库或非法 URL 且不回显密码', () => {
    for (const url of [
      'postgresql://snake:production-secret@db/snake',
      'mysql://snake:mysql-secret@db/snake_test',
      'not-a-url-with-secret',
    ]) {
      assert.throws(
        () => assertSafeTestDatabaseUrl(url),
        (error) => (
          /TEST_DATABASE_URL|测试数据库/u.test(error.message)
          && !error.message.includes('production-secret')
          && !error.message.includes('mysql-secret')
          && !error.message.includes('not-a-url-with-secret')
        ),
      );
    }
  });
});

describe('测试 Pool 生命周期助手', () => {
  test('createTestPool 使用 TEST_DATABASE_URL 构造注入的 Pool', () => {
    RecordingPool.instances.length = 0;
    const databaseUrl = 'postgresql://snake:test-secret@db/snake_test';

    const pool = createTestPool({ databaseUrl, PoolImpl: RecordingPool });

    assert.equal(pool, RecordingPool.instances[0]);
    assert.deepEqual(pool.options, { connectionString: databaseUrl });
  });

  test('createTestPool 缺少 TEST_DATABASE_URL 时清晰失败', () => {
    assert.throws(
      () => createTestPool({ databaseUrl: null, PoolImpl: RecordingPool }),
      /TEST_DATABASE_URL.*未配置/u,
    );
  });

  test('createTestPool 不为非测试数据库创建连接池', () => {
    RecordingPool.instances.length = 0;

    assert.throws(
      () => createTestPool({
        databaseUrl: 'postgresql://snake:production-secret@db/snake',
        PoolImpl: RecordingPool,
      }),
      /名称包含 _test 或 -test/u,
    );
    assert.equal(RecordingPool.instances.length, 0);
  });

  test('resetTestDatabase 在校验通过后重建 public schema', async () => {
    const recorder = createResetPool('snake_test');

    await resetTestDatabase({
      pool: recorder.pool,
      databaseUrl: 'postgresql://snake:secret@db/snake_test',
    });

    assert.deepEqual(recorder.queries, [
      'SELECT current_database() AS database_name',
      'BEGIN',
      'DROP SCHEMA public CASCADE',
      'CREATE SCHEMA public',
      'COMMIT',
    ]);
    assert.equal(recorder.connectCalls, 1);
    assert.equal(recorder.releases, 1);
  });

  test('resetTestDatabase 对非测试库不会发送任何 SQL', async () => {
    const recorder = createResetPool('snake');

    await assert.rejects(
      resetTestDatabase({
        pool: recorder.pool,
        databaseUrl: 'postgresql://snake:production-secret@db/snake',
      }),
      /测试数据库/u,
    );
    assert.deepEqual(recorder.queries, []);
    assert.equal(recorder.connectCalls, 0);
  });

  test('resetTestDatabase 拒绝 URL 与 Pool 实际数据库不匹配且不执行破坏 SQL', async () => {
    const recorder = createResetPool('production');

    await assert.rejects(
      resetTestDatabase({
        pool: recorder.pool,
        databaseUrl: 'postgresql://snake:test-secret@db/snake_test',
      }),
      /实际连接.*测试数据库.*不匹配/u,
    );

    assert.deepEqual(recorder.queries, ['SELECT current_database() AS database_name']);
    assert.equal(recorder.releases, 1);
  });

  test('resetTestDatabase 的 ROLLBACK 失败时用错误释放 client', async () => {
    const recorder = createResetPool('snake_test', {
      failOnSql: 'DROP SCHEMA public CASCADE',
      failOnRollback: true,
    });

    await assert.rejects(
      resetTestDatabase({
        pool: recorder.pool,
        databaseUrl: 'postgresql://snake:test-secret@db/snake_test',
      }),
      (error) => error === recorder.operationError,
    );

    assert.equal(recorder.releaseArguments[0], recorder.rollbackError);
  });

  test('closeTestPool 等待 pool.end', async () => {
    let ended = false;
    await closeTestPool({
      async end() {
        ended = true;
      },
    });

    assert.equal(ended, true);
  });
});
