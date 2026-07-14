import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  assertSafeTestDatabaseUrl,
  closeTestPool,
  createTestPool,
  getTestDatabaseUrl,
  resetTestDatabase,
} from '../helpers/test-database.mjs';

const SAFE_IDENTITY_QUERY = (
  'SELECT pg_catalog.current_database() AS database_name, session_user AS user_name'
);

class RecordingPool {
  static instances = [];

  constructor(options) {
    this.options = options;
    RecordingPool.instances.push(this);
  }
}

class ResettablePool {
  constructor(options) {
    const parsed = new URL(options.connectionString);
    this.options = options;
    this.actualDatabaseName = decodeURIComponent(parsed.pathname.slice(1));
    this.actualUserName = decodeURIComponent(parsed.username);
    this.queries = [];
    this.releaseArguments = [];
    this.operationError = new Error('reset-operation-secret');
    this.rollbackError = new Error('reset-rollback-secret');
    this.releaseError = new Error('reset-release-secret');
    this.endError = new Error('reset-end-secret');
    this.failOnSql = null;
    this.failOnRollback = false;
    this.failOnRelease = false;
    this.failOnEnd = false;
    this.connectCalls = 0;
    this.releases = 0;
    this.ended = false;
  }

  async connect() {
    this.connectCalls += 1;
    return {
      query: async (text) => {
        this.queries.push(text);
        if (text === this.failOnSql) {
          throw this.operationError;
        }
        if (text === SAFE_IDENTITY_QUERY) {
          return {
            rows: [{
              database_name: this.actualDatabaseName,
              user_name: this.actualUserName,
            }],
          };
        }
        if (text === 'ROLLBACK' && this.failOnRollback) {
          throw this.rollbackError;
        }
        return { rows: [] };
      },
      release: (error) => {
        this.releases += 1;
        this.releaseArguments.push(error);
        if (this.failOnRelease) {
          throw this.releaseError;
        }
      },
    };
  }

  async end() {
    this.ended = true;
    if (this.failOnEnd) {
      throw this.endError;
    }
  }
}

function createBoundResetPool(databaseUrl = 'postgresql://snake:secret@db/snake_test') {
  return createTestPool({ databaseUrl, PoolImpl: ResettablePool });
}

function ddlQueries(pool) {
  return pool.queries.filter((sql) => /^(?:ALTER|CREATE|DROP|TRUNCATE)\s/iu.test(sql));
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

  test('安全校验只接受数据库名严格以 _test 或 -test 结尾的 PostgreSQL URL', () => {
    assert.equal(
      assertSafeTestDatabaseUrl('postgresql://snake:secret@db/snake_test'),
      'postgresql://snake:secret@db/snake_test',
    );
    assert.equal(
      assertSafeTestDatabaseUrl('postgres://snake:secret@db/docker-snake-test?sslmode=require'),
      'postgres://snake:secret@db/docker-snake-test?sslmode=require',
    );

    for (const unsafeUrl of [
      'postgresql://snake:secret@db/prod_test_backup',
      'postgresql://snake:secret@db/prod-test-backup',
    ]) {
      assert.throws(
        () => assertSafeTestDatabaseUrl(unsafeUrl),
        /必须以 _test 或 -test 结尾/u,
      );
    }
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

  test('要求显式数据库用户，并按 URL 规则解码用户身份', async () => {
    assert.throws(
      () => assertSafeTestDatabaseUrl('postgresql://db.example.test/snake_test'),
      /必须显式包含数据库用户/u,
    );

    const pool = createBoundResetPool(
      'postgresql://snake%5Fuser:secret@db.example.test/snake_test',
    );
    await resetTestDatabase({ pool });

    assert.equal(pool.actualUserName, 'snake_user');
    assert.equal(pool.releases, 1);
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
      /必须以 _test 或 -test 结尾/u,
    );
    assert.equal(RecordingPool.instances.length, 0);
  });

  test('resetTestDatabase 在校验通过后只清理本项目已知表', async () => {
    const pool = createBoundResetPool();

    await resetTestDatabase({ pool });

    assert.deepEqual(pool.queries, [
      SAFE_IDENTITY_QUERY,
      'BEGIN',
      'DROP TABLE IF EXISTS public.user_sessions',
      'DROP TABLE IF EXISTS public.users',
      'DROP TABLE IF EXISTS public.schema_migrations',
      'COMMIT',
    ]);
    assert.equal(pool.connectCalls, 1);
    assert.equal(pool.releases, 1);
    assert.doesNotMatch(pool.queries.join('\n'), /DROP\s+SCHEMA|CASCADE/iu);
  });

  test('resetTestDatabase 对非测试库不会发送任何 SQL', async () => {
    const instancesBefore = RecordingPool.instances.length;

    assert.throws(
      () => createTestPool({
        databaseUrl: 'postgresql://snake:production-secret@db/prod_test_backup',
        PoolImpl: RecordingPool,
      }),
      /必须以 _test 或 -test 结尾/u,
    );
    assert.equal(RecordingPool.instances.length, instancesBefore);
  });

  test('resetTestDatabase 拒绝并非由 helper 创建的同名同用户 Pool', async () => {
    const roguePool = new ResettablePool({
      connectionString: 'postgresql://snake:secret@other.example.test/snake_test',
    });

    await assert.rejects(
      resetTestDatabase({
        pool: roguePool,
        databaseUrl: 'postgresql://snake:test-secret@db/snake_test',
      }),
      /必须由 createTestPool 创建/u,
    );

    assert.deepEqual(roguePool.queries, []);
    assert.equal(roguePool.connectCalls, 0);
  });

  test('resetTestDatabase 核对实际数据库与用户且身份不符时不发送 DDL', async (t) => {
    await t.test('数据库不匹配', async () => {
      const pool = createBoundResetPool();
      pool.actualDatabaseName = 'other_test';
      let mismatchError;

      await assert.rejects(
        resetTestDatabase({ pool }),
        (error) => {
          mismatchError = error;
          return /实际连接身份.*不匹配/u.test(error.message);
        },
      );

      assert.deepEqual(ddlQueries(pool), []);
      assert.equal(pool.releases, 1);
      assert.doesNotMatch(
        mismatchError.message,
        /secret|snake_test|other_test|snake(?:_user)?|production_owner/u,
      );
    });

    await t.test('用户不匹配', async () => {
      const pool = createBoundResetPool();
      pool.actualUserName = 'production_owner';

      await assert.rejects(resetTestDatabase({ pool }), /实际连接身份.*不匹配/u);

      assert.deepEqual(ddlQueries(pool), []);
      assert.equal(pool.releases, 1);
    });
  });

  test('身份查询失败时不发送 DDL 并正常释放 client', async () => {
    const pool = createBoundResetPool();
    pool.failOnSql = SAFE_IDENTITY_QUERY;

    await assert.rejects(
      resetTestDatabase({ pool }),
      (error) => error === pool.operationError,
    );

    assert.deepEqual(ddlQueries(pool), []);
    assert.equal(pool.releases, 1);
    assert.equal(pool.releaseArguments[0], undefined);
  });

  test('release 失败不覆盖原始 reset 错误，成功路径则传播 release 错误', async (t) => {
    await t.test('保留原始 reset 错误', async () => {
      const pool = createBoundResetPool();
      pool.failOnSql = 'DROP TABLE IF EXISTS public.user_sessions';
      pool.failOnRelease = true;

      await assert.rejects(
        resetTestDatabase({ pool }),
        (error) => error === pool.operationError,
      );
      assert.equal(pool.releases, 1);
    });

    await t.test('无更早错误时传播 release 错误', async () => {
      const pool = createBoundResetPool();
      pool.failOnRelease = true;

      await assert.rejects(
        resetTestDatabase({ pool }),
        (error) => error === pool.releaseError,
      );
      assert.equal(pool.releases, 1);
    });
  });

  test('resetTestDatabase 的 ROLLBACK 失败时用错误释放 client', async () => {
    const pool = createBoundResetPool();
    pool.failOnSql = 'DROP TABLE IF EXISTS public.user_sessions';
    pool.failOnRollback = true;

    await assert.rejects(
      resetTestDatabase({ pool }),
      (error) => error === pool.operationError,
    );

    assert.equal(pool.releaseArguments[0], pool.rollbackError);
  });

  test('closeTestPool 等待 pool.end 且即使关闭失败也撤销身份绑定', async (t) => {
    await t.test('成功关闭', async () => {
      const pool = createBoundResetPool();
      await closeTestPool(pool);

      assert.equal(pool.ended, true);
      await assert.rejects(resetTestDatabase({ pool }), /必须由 createTestPool 创建/u);
      assert.equal(pool.connectCalls, 0);
    });

    await t.test('关闭失败仍保留 end 原始错误并撤销绑定', async () => {
      const pool = createBoundResetPool();
      pool.failOnEnd = true;

      await assert.rejects(closeTestPool(pool), (error) => error === pool.endError);
      await assert.rejects(resetTestDatabase({ pool }), /必须由 createTestPool 创建/u);
      assert.equal(pool.connectCalls, 0);
    });
  });
});
