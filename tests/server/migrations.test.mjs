import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  loadMigrations,
  runMigrations,
} from '../../server/database/migrations.js';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => (
    rm(directory, { recursive: true, force: true })
  )));
});

async function createMigrationsDirectory(files) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'docker-snake-migrations-'));
  temporaryDirectories.push(directory);

  await Promise.all(Object.entries(files).map(([filename, contents]) => (
    writeFile(path.join(directory, filename), contents, 'utf8')
  )));

  return directory;
}

function compactSql(sql) {
  return sql.trim().replace(/\s+/gu, ' ');
}

function createLogger() {
  const entries = [];
  return {
    entries,
    info(...args) {
      entries.push(args);
    },
    error(...args) {
      entries.push(args);
    },
  };
}

function createRecordingPool({ appliedVersions = [], failOnSql, failOnRollback = false } = {}) {
  const ledger = new Set(appliedVersions);
  const calls = [];
  const releaseArguments = [];
  const rollbackError = new Error('rollback-connection-secret');
  let releases = 0;
  let connectCalls = 0;

  const client = {
    async query(text, values) {
      calls.push({ text, values });

      if (text === failOnSql) {
        throw new Error('postgresql://snake:migration-secret@db.example.test/snake_test');
      }
      if (text === 'ROLLBACK' && failOnRollback) {
        throw rollbackError;
      }

      if (/^SELECT\s+version\s+FROM\s+schema_migrations/iu.test(compactSql(text))) {
        return { rows: [...ledger].map((version) => ({ version })) };
      }

      if (/^INSERT\s+INTO\s+schema_migrations/iu.test(compactSql(text))) {
        ledger.add(values[0]);
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
      async query() {
        throw new Error('迁移不得通过 pool.query 执行');
      },
    },
    calls,
    ledger,
    releaseArguments,
    rollbackError,
    get releases() {
      return releases;
    },
    get connectCalls() {
      return connectCalls;
    },
  };
}

describe('loadMigrations', () => {
  test('默认读取 001 初始迁移且迁移与条目均冻结', async () => {
    const migrations = await loadMigrations();

    assert.deepEqual(migrations.map(({ version }) => version), ['001-initial-schema.sql']);
    assert.equal(Object.isFrozen(migrations), true);
    assert.equal(Object.isFrozen(migrations[0]), true);

    const sql = compactSql(migrations[0].sql);
    assert.match(sql, /CREATE TABLE users/iu);
    assert.match(sql, /id bigserial PRIMARY KEY/iu);
    assert.match(sql, /username varchar\(20\) NOT NULL/iu);
    assert.match(sql, /CONSTRAINT users_username_unique UNIQUE\s*\(username\)/iu);
    assert.match(sql, /CHECK\s*\(username\s*~\s*'\^\[a-z0-9_\]\{3,20\}\$'/iu);
    assert.match(sql, /password_hash text NOT NULL/iu);
    assert.match(sql, /best_score integer NOT NULL DEFAULT 0/iu);
    assert.match(sql, /best_score\s+BETWEEN\s+0\s+AND\s+3960/iu);
    assert.match(sql, /best_score\s*%\s*10\s*=\s*0/iu);
    assert.match(sql, /best_score\s*=\s*0\s+AND\s+best_score_at\s+IS\s+NULL/iu);
    assert.match(sql, /best_score\s*>\s*0\s+AND\s+best_score_at\s+IS\s+NOT\s+NULL/iu);
    assert.match(sql, /created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP/iu);
    assert.match(sql, /CREATE INDEX users_leaderboard_order_idx\s+ON users\s*\(best_score DESC, best_score_at ASC, id ASC\)\s+WHERE best_score > 0/iu);
    assert.match(sql, /CREATE TABLE user_sessions/iu);
    assert.match(sql, /sid varchar[^,]*PRIMARY KEY/iu);
    assert.match(sql, /sess json NOT NULL/iu);
    assert.match(sql, /expire timestamp\(6\) NOT NULL/iu);
    assert.match(sql, /CREATE INDEX user_sessions_expire_idx\s+ON user_sessions\s*\(expire\)/iu);
    assert.doesNotMatch(sql, /schema_migrations/iu);
    assert.doesNotMatch(sql, /FOREIGN KEY|REFERENCES users/iu);
  });

  test('只读取合法 SQL 文件并按完整文件名排序', async () => {
    const migrationsDir = await createMigrationsDirectory({
      '010-last.sql': 'SELECT 10;',
      '002-first.sql': 'SELECT 2;',
      'README.md': 'ignored',
    });

    const migrations = await loadMigrations({ migrationsDir });

    assert.deepEqual(migrations, [
      { version: '002-first.sql', sql: 'SELECT 2;' },
      { version: '010-last.sql', sql: 'SELECT 10;' },
    ]);
  });

  test('拒绝不符合三位版本与小写命名规则的 SQL 文件', async () => {
    const migrationsDir = await createMigrationsDirectory({
      '01-Bad_Name.sql': 'SELECT 1;',
    });

    await assert.rejects(
      loadMigrations({ migrationsDir }),
      /迁移文件名.*01-Bad_Name\.sql.*不合法/u,
    );
  });

  test('拒绝重复的三位数字版本前缀', async () => {
    const migrationsDir = await createMigrationsDirectory({
      '001-first.sql': 'SELECT 1;',
      '001-second.sql': 'SELECT 2;',
    });

    await assert.rejects(
      loadMigrations({ migrationsDir }),
      /迁移版本前缀.*001.*重复/u,
    );
  });
});

describe('runMigrations', () => {
  test('在同一 client 的事务与 advisory lock 内按版本执行未应用迁移', async () => {
    const recorder = createRecordingPool({ appliedVersions: ['002-second.sql'] });
    const logger = createLogger();
    const migrations = [
      { version: '003-third.sql', sql: "SELECT 'third-body';" },
      { version: '001-first.sql', sql: "SELECT 'first-body';" },
      { version: '002-second.sql', sql: "SELECT 'second-body';" },
    ];

    const applied = await runMigrations({ pool: recorder.pool, migrations, logger });

    assert.deepEqual(applied, ['001-first.sql', '003-third.sql']);
    assert.equal(recorder.connectCalls, 1);
    assert.equal(recorder.releases, 1);

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements[0], 'BEGIN');
    assert.match(statements[1], /^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)$/iu);
    assert.deepEqual(recorder.calls[1].values, ['docker_snake:schema-migrations']);
    assert.match(statements[2], /^CREATE TABLE IF NOT EXISTS schema_migrations/iu);
    assert.match(statements[2], /version varchar\(255\) PRIMARY KEY/iu);
    assert.match(statements[2], /applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP/iu);
    assert.match(statements[3], /^SELECT version FROM schema_migrations/iu);
    assert.equal(statements[4], "SELECT 'first-body';");
    assert.match(statements[5], /^INSERT INTO schema_migrations\s*\(version\)\s*VALUES\s*\(\$1\)$/iu);
    assert.deepEqual(recorder.calls[5].values, ['001-first.sql']);
    assert.equal(statements[6], "SELECT 'third-body';");
    assert.deepEqual(recorder.calls[7].values, ['003-third.sql']);
    assert.equal(statements[8], 'COMMIT');
    assert.equal(statements.includes("SELECT 'second-body';"), false);
    assert.deepEqual([...recorder.ledger].sort(), [
      '001-first.sql',
      '002-second.sql',
      '003-third.sql',
    ]);
    assert.deepEqual(logger.entries, [
      [{ event: 'database_migration_applied', version: '001-first.sql' }],
      [{ event: 'database_migration_applied', version: '003-third.sql' }],
    ]);
  });

  test('第二次运行会先加锁再读 ledger，且不重复执行正文', async () => {
    const recorder = createRecordingPool();
    const logger = createLogger();
    const migrations = [{ version: '001-once.sql', sql: "SELECT 'only-once';" }];

    assert.deepEqual(await runMigrations({ pool: recorder.pool, migrations, logger }), ['001-once.sql']);
    assert.deepEqual(await runMigrations({ pool: recorder.pool, migrations, logger }), []);

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.filter((sql) => sql === "SELECT 'only-once';").length, 1);
    const secondBegin = statements.lastIndexOf('BEGIN');
    const secondLock = statements.findIndex((sql, index) => (
      index > secondBegin && /pg_advisory_xact_lock/iu.test(sql)
    ));
    const secondLedgerRead = statements.findIndex((sql, index) => (
      index > secondBegin && /^SELECT version FROM schema_migrations/iu.test(sql)
    ));
    assert.ok(secondBegin >= 0 && secondLock > secondBegin && secondLedgerRead > secondLock);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.equal(recorder.releases, 2);
  });

  test('正文失败时回滚、释放 client、原样抛错且日志不泄漏', async () => {
    const sensitiveSql = "SELECT 'migration-body-secret';";
    const recorder = createRecordingPool({ failOnSql: sensitiveSql });
    const logger = createLogger();

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '001-failing.sql', sql: sensitiveSql }],
        logger,
      }),
      /migration-secret/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.equal(statements.includes('COMMIT'), false);
    assert.equal(recorder.releases, 1);
    assert.deepEqual(logger.entries, [[{ event: 'database_migration_failed' }]]);
    assert.doesNotMatch(inspect(logger.entries), /migration-secret|migration-body-secret|postgresql|Error/u);
  });

  test('ROLLBACK 失败时用错误释放 client 但仍抛出原始迁移错误', async () => {
    const sensitiveSql = "SELECT 'migration-body-secret';";
    const recorder = createRecordingPool({
      failOnSql: sensitiveSql,
      failOnRollback: true,
    });
    const logger = createLogger();

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '001-failing.sql', sql: sensitiveSql }],
        logger,
      }),
      /migration-secret/u,
    );

    assert.equal(recorder.releaseArguments[0], recorder.rollbackError);
    assert.deepEqual(logger.entries, [[{ event: 'database_migration_failed' }]]);
  });

  test('日志方法 getter 抛错不覆盖已提交结果或原始迁移错误', async (t) => {
    await t.test('已提交结果仍正常返回', async () => {
      const recorder = createRecordingPool();
      const logger = {};
      Object.defineProperty(logger, 'info', {
        get() {
          throw new Error('logger-info-getter-secret');
        },
      });

      assert.deepEqual(await runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '001-success.sql', sql: 'SELECT 1;' }],
        logger,
      }), ['001-success.sql']);
      assert.equal(compactSql(recorder.calls.at(-1).text), 'COMMIT');
      assert.equal(recorder.releases, 1);
    });

    await t.test('失败时仍抛出原始数据库错误', async () => {
      const sensitiveSql = "SELECT 'migration-body-secret';";
      const recorder = createRecordingPool({ failOnSql: sensitiveSql });
      const logger = {};
      Object.defineProperty(logger, 'error', {
        get() {
          throw new Error('logger-error-getter-secret');
        },
      });

      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '001-failure.sql', sql: sensitiveSql }],
          logger,
        }),
        /migration-secret/u,
      );
      assert.equal(compactSql(recorder.calls.at(-1).text), 'ROLLBACK');
      assert.equal(recorder.releases, 1);
    });
  });

  test('注入迁移也必须校验文件名、SQL 内容与版本前缀', async (t) => {
    const recorder = createRecordingPool();

    await t.test('非法版本名', async () => {
      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '../001-escape.sql', sql: 'SELECT 1;' }],
        }),
        /迁移文件名.*不合法/u,
      );
    });

    await t.test('SQL 不是字符串', async () => {
      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '001-valid.sql', sql: null }],
        }),
        /迁移.*SQL.*字符串/u,
      );
    });

    await t.test('重复版本前缀', async () => {
      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [
            { version: '001-first.sql', sql: 'SELECT 1;' },
            { version: '001-second.sql', sql: 'SELECT 2;' },
          ],
        }),
        /迁移版本前缀.*001.*重复/u,
      );
    });

    await t.test('稀疏数组条目', async () => {
      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: Array(1),
        }),
        /迁移条目.*version.*sql/u,
      );
    });

    assert.equal(recorder.connectCalls, 0);
  });
});
