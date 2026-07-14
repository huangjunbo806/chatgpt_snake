import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { runMigrations } from '../../server/database/migrations.js';
import { createPostgresSessionStore } from '../../server/database/session-store.js';
import { UsernameConflictError } from '../../server/repositories/errors.js';
import { createUserRepository } from '../../server/repositories/user-repository.js';
import {
  assertSafeTestDatabaseUrl,
  closeTestPool,
  createTestPool,
  getTestDatabaseUrl,
  resetTestDatabase,
} from '../helpers/test-database.mjs';

const databaseUrl = getTestDatabaseUrl();
const silentLogger = Object.freeze({
  info() {},
  error() {},
});

function callStore(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (error, value) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(value);
    });
  });
}

if (databaseUrl === null) {
  test('PostgreSQL 数据库集成测试', {
    skip: '未设置 TEST_DATABASE_URL；未创建数据库连接',
  }, () => {});
} else {
  describe('PostgreSQL 数据库集成', { concurrency: false }, () => {
    let pool;

    before(async () => {
      assertSafeTestDatabaseUrl(databaseUrl);
      pool = createTestPool({ databaseUrl });
      await resetTestDatabase({ pool, databaseUrl });
    });

    after(async () => {
      if (!pool) {
        return;
      }

      try {
        await resetTestDatabase({ pool, databaseUrl });
      } finally {
        await closeTestPool(pool);
      }
    });

    test('迁移幂等、schema 可用、用户约束生效且 Session Store 可读写销毁', async () => {
      const firstApplied = await runMigrations({ pool, logger: silentLogger });
      const secondApplied = await runMigrations({ pool, logger: silentLogger });

      assert.deepEqual(firstApplied, ['001-initial-schema.sql']);
      assert.deepEqual(secondApplied, []);

      const catalogResult = await pool.query(
        `
          SELECT
            to_regclass($1) AS users_table,
            to_regclass($2) AS sessions_table,
            to_regclass($3) AS ledger_table,
            to_regclass($4) AS leaderboard_index,
            to_regclass($5) AS sessions_expire_index
        `,
        [
          'public.users',
          'public.user_sessions',
          'public.schema_migrations',
          'public.users_leaderboard_order_idx',
          'public.user_sessions_expire_idx',
        ],
      );
      assert.deepEqual(catalogResult.rows[0], {
        users_table: 'users',
        sessions_table: 'user_sessions',
        ledger_table: 'schema_migrations',
        leaderboard_index: 'users_leaderboard_order_idx',
        sessions_expire_index: 'user_sessions_expire_idx',
      });

      const repository = createUserRepository({ pool });
      const created = await repository.create({
        username: 'integration_user',
        passwordHash: 'integration-password-hash',
      });
      assert.match(created.id, /^\d+$/u);
      assert.deepEqual(created, {
        id: created.id,
        username: 'integration_user',
        bestScore: 0,
        bestScoreAt: null,
      });

      const credentials = await repository.findCredentialsByUsername('integration_user');
      assert.deepEqual(credentials, {
        ...created,
        passwordHash: 'integration-password-hash',
      });
      assert.deepEqual(await repository.findPublicById(created.id), created);
      await assert.rejects(
        repository.create({
          username: 'integration_user',
          passwordHash: 'another-password-hash',
        }),
        UsernameConflictError,
      );

      const store = createPostgresSessionStore({ pool, logger: silentLogger });
      const sid = 'integration-session-id';
      const session = {
        cookie: { expires: new Date(Date.now() + 60_000).toISOString() },
        userId: created.id,
      };

      try {
        await callStore(store, 'set', sid, session);
        assert.deepEqual(await callStore(store, 'get', sid), session);
        await callStore(store, 'destroy', sid);
        assert.equal(await callStore(store, 'get', sid), undefined);
      } finally {
        await store.close();
      }
    });
  });
}
