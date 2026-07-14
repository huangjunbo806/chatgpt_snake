import assert from 'node:assert/strict';
import {
  after,
  before,
  beforeEach,
  describe,
  test,
} from 'node:test';

import { loadMigrations, runMigrations } from '../../server/database/migrations.js';
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
      let databaseIdentityVerified = false;

      try {
        await resetTestDatabase({ pool });
        databaseIdentityVerified = true;
        await pool.query('DROP TABLE IF EXISTS public.database_integration_sentinel');
        await pool.query(`
          CREATE TABLE public.database_integration_sentinel (
            marker text PRIMARY KEY,
            payload text NOT NULL
          )
        `);
        await pool.query(
          `
            INSERT INTO public.database_integration_sentinel (marker, payload)
            VALUES ($1, $2)
          `,
          ['preserved-by-reset', 'sentinel row'],
        );
      } catch (setupError) {
        if (databaseIdentityVerified) {
          try {
            await pool.query('DROP TABLE IF EXISTS public.database_integration_sentinel');
          } catch {
            // 保留触发集成测试初始化失败的原始异常。
          }
        }
        try {
          await closeTestPool(pool);
        } catch {
          // 保留触发集成测试初始化失败的原始异常。
        }
        pool = null;
        throw setupError;
      }
    });

    beforeEach(async () => {
      await resetTestDatabase({ pool });
    });

    after(async () => {
      if (!pool) {
        return;
      }

      try {
        await resetTestDatabase({ pool });
      } finally {
        try {
          await pool.query('DROP TABLE IF EXISTS public.database_integration_sentinel');
        } finally {
          await closeTestPool(pool);
        }
      }
    });

    test('reset 只移除项目已知表并保留 public sentinel 表与行', async () => {
      await runMigrations({ pool, logger: silentLogger });

      await resetTestDatabase({ pool });

      const catalogResult = await pool.query(
        `
          SELECT
            to_regclass($1) AS users_table,
            to_regclass($2) AS sessions_table,
            to_regclass($3) AS ledger_table,
            to_regclass($4) AS sentinel_table
        `,
        [
          'public.users',
          'public.user_sessions',
          'public.schema_migrations',
          'public.database_integration_sentinel',
        ],
      );
      assert.deepEqual(catalogResult.rows[0], {
        users_table: null,
        sessions_table: null,
        ledger_table: null,
        sentinel_table: 'database_integration_sentinel',
      });

      const sentinelResult = await pool.query(
        `
          SELECT marker, payload
          FROM public.database_integration_sentinel
          WHERE marker = $1
        `,
        ['preserved-by-reset'],
      );
      assert.deepEqual(sentinelResult.rows, [{
        marker: 'preserved-by-reset',
        payload: 'sentinel row',
      }]);
    });

    test('并发 runMigrations 由 advisory lock 串行化且每个版本只应用一次', async () => {
      const migrations = [
        {
          version: '901-concurrent-first.sql',
          sql: `
            INSERT INTO public.database_integration_sentinel (marker, payload)
            VALUES ('concurrent-first', 'applied once');
            SELECT pg_sleep(0.1);
          `,
        },
        {
          version: '902-concurrent-second.sql',
          sql: `
            INSERT INTO public.database_integration_sentinel (marker, payload)
            VALUES ('concurrent-second', 'applied once');
          `,
        },
      ];
      const versions = migrations.map(({ version }) => version);

      const results = await Promise.all([
        runMigrations({ pool, migrations, logger: silentLogger }),
        runMigrations({ pool, migrations, logger: silentLogger }),
      ]);

      assert.deepEqual(
        results.map((applied) => applied.length).sort((left, right) => left - right),
        [0, versions.length],
      );
      assert.deepEqual(results.flat().sort(), [...versions].sort());

      const bodyResult = await pool.query(`
        SELECT marker, count(*)::integer AS applications
        FROM public.database_integration_sentinel
        WHERE marker IN ('concurrent-first', 'concurrent-second')
        GROUP BY marker
        ORDER BY marker
      `);
      assert.deepEqual(bodyResult.rows, [
        { marker: 'concurrent-first', applications: 1 },
        { marker: 'concurrent-second', applications: 1 },
      ]);

      const ledgerResult = await pool.query(
        `
          SELECT version, count(*)::integer AS applications
          FROM public.schema_migrations
          WHERE version = ANY($1::text[])
          GROUP BY version
          ORDER BY version
        `,
        [versions],
      );
      assert.deepEqual(ledgerResult.rows, versions.map((version) => ({
        version,
        applications: 1,
      })));
    });

    test('迁移正文失败时同一事务内的正文数据与 ledger 条目均回滚', async () => {
      const transactionalMigrations = [
        {
          version: '912-rollback-body.sql',
          sql: `
            INSERT INTO public.users (username, password_hash)
            VALUES ('rollback_body', 'must be rolled back');
          `,
        },
        {
          version: '913-rollback-failure.sql',
          sql: `
            INSERT INTO public.users (username, password_hash)
            VALUES ('rollback_failure', 'must be rolled back');
            SELECT 1 / 0;
          `,
        },
      ];
      const versions = transactionalMigrations.map(({ version }) => version);
      const migrationSet = [
        ...await loadMigrations(),
        ...transactionalMigrations,
      ];

      assert.deepEqual(
        await runMigrations({ pool, logger: silentLogger }),
        ['001-initial-schema.sql'],
      );

      await assert.rejects(
        runMigrations({
          pool,
          migrations: migrationSet,
          logger: silentLogger,
        }),
        (error) => {
          assert.equal(error?.code, '22012');
          return true;
        },
      );

      const bodyResult = await pool.query(
        `
          SELECT username
          FROM public.users
          WHERE username = ANY($1::text[])
          ORDER BY username
        `,
        [['rollback_body', 'rollback_failure']],
      );
      assert.deepEqual(bodyResult.rows, []);

      const ledgerResult = await pool.query(
        `
          SELECT version
          FROM public.schema_migrations
          WHERE version = ANY($1::text[])
          ORDER BY version
        `,
        [versions],
      );
      assert.deepEqual(ledgerResult.rows, []);
    });

    test('users 的 username 与 best_score CHECK 约束真实拒绝非法值', async () => {
      await runMigrations({ pool, logger: silentLogger });

      await assert.rejects(
        pool.query(
          `
            INSERT INTO public.users (username, password_hash)
            VALUES ($1, $2)
          `,
          ['Invalid-Username', 'integration-password-hash'],
        ),
        (error) => {
          assert.equal(error?.code, '23514');
          assert.equal(error?.constraint, 'users_username_format_check');
          return true;
        },
      );

      await assert.rejects(
        pool.query(
          `
            INSERT INTO public.users (
              username,
              password_hash,
              best_score,
              best_score_at
            )
            VALUES ($1, $2, $3, CURRENT_TIMESTAMP)
          `,
          ['invalid_score', 'integration-password-hash', 15],
        ),
        (error) => {
          assert.equal(error?.code, '23514');
          assert.equal(error?.constraint, 'users_best_score_check');
          return true;
        },
      );

      const rejectedRows = await pool.query(
        `
          SELECT username
          FROM public.users
          WHERE username = ANY($1::text[])
        `,
        [['Invalid-Username', 'invalid_score']],
      );
      assert.deepEqual(rejectedRows.rows, []);
    });

    test('迁移幂等、schema 与仓储可用且 Session Store 可读写销毁', async () => {
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
