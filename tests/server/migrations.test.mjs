import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS,
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

function sha256(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
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

function createRecordingPool({
  appliedMigrations = [],
  failOnSql,
  failOnRollback = false,
  failOnRelease = false,
} = {}) {
  let ledger = new Map(appliedMigrations.map(({ version, checksum }) => [version, checksum]));
  let transactionLedger = null;
  const calls = [];
  const releaseArguments = [];
  const rollbackError = new Error('rollback-connection-secret');
  const releaseError = new Error('release-connection-secret');
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

      const compact = compactSql(text);
      if (compact === 'BEGIN') {
        transactionLedger = new Map(ledger);
      }

      if (/^SELECT\s+version,\s*checksum\s+FROM\s+public\.schema_migrations/iu.test(compact)) {
        const activeLedger = transactionLedger ?? ledger;
        return {
          rows: [...activeLedger].map(([version, checksum]) => ({ version, checksum })),
        };
      }

      if (/^INSERT\s+INTO\s+public\.schema_migrations/iu.test(compact)) {
        (transactionLedger ?? ledger).set(values[0], values[1]);
      }

      if (/^UPDATE\s+public\.schema_migrations\s+SET\s+checksum/iu.test(compact)) {
        const activeLedger = transactionLedger ?? ledger;
        const [checksum, version] = values;
        if (activeLedger.get(version) === null) {
          activeLedger.set(version, checksum);
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }

      if (compact === 'COMMIT') {
        ledger = transactionLedger ?? ledger;
        transactionLedger = null;
      }

      if (compact === 'ROLLBACK') {
        transactionLedger = null;
      }

      return { rows: [] };
    },
    release(error) {
      releases += 1;
      releaseArguments.push(error);
      if (failOnRelease) {
        throw releaseError;
      }
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
    get ledger() {
      return ledger;
    },
    releaseArguments,
    releaseError,
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
    assert.match(sql, /CREATE TABLE public\.users/iu);
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
    assert.match(sql, /CREATE INDEX users_leaderboard_order_idx\s+ON public\.users\s*\(best_score DESC, best_score_at ASC, id ASC\)\s+WHERE best_score > 0/iu);
    assert.match(sql, /CREATE TABLE public\.user_sessions/iu);
    assert.match(sql, /sid varchar[^,]*PRIMARY KEY/iu);
    assert.match(sql, /sess json NOT NULL/iu);
    assert.match(sql, /expire timestamp\(6\) NOT NULL/iu);
    assert.match(sql, /CREATE INDEX user_sessions_expire_idx\s+ON public\.user_sessions\s*\(expire\)/iu);
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

  test('拒绝只含空白字符的迁移文件', async () => {
    const migrationsDir = await createMigrationsDirectory({
      '001-blank.sql': ' \n\t\uFEFF',
    });

    await assert.rejects(
      loadMigrations({ migrationsDir }),
      /迁移.*001-blank\.sql.*SQL.*不能为空/u,
    );
  });
});

describe('runMigrations', () => {
  test('在同一 client 的事务与 advisory lock 内按版本执行未应用迁移', async () => {
    const firstSql = "SELECT 'first-body';";
    const secondSql = "SELECT 'second-body';";
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '001-first.sql', checksum: sha256(firstSql) }],
    });
    const logger = createLogger();
    const migrations = [
      { version: '003-third.sql', sql: "SELECT 'third-body';" },
      { version: '001-first.sql', sql: firstSql },
      { version: '002-second.sql', sql: secondSql },
    ];

    const applied = await runMigrations({ pool: recorder.pool, migrations, logger });

    assert.deepEqual(applied, ['002-second.sql', '003-third.sql']);
    assert.equal(recorder.connectCalls, 1);
    assert.equal(recorder.releases, 1);

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements[0], 'BEGIN');
    assert.match(statements[1], /^SELECT set_config\('statement_timeout', \$1, true\)$/iu);
    assert.equal(DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS, 30_000);
    assert.deepEqual(recorder.calls[1].values, [`${DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS}ms`]);
    assert.match(statements[2], /^SELECT pg_advisory_xact_lock\(hashtext\(\$1\)\)$/iu);
    assert.deepEqual(recorder.calls[2].values, ['docker_snake:schema-migrations']);
    assert.match(statements[3], /^CREATE TABLE IF NOT EXISTS public\.schema_migrations/iu);
    assert.match(statements[3], /version varchar\(255\) PRIMARY KEY/iu);
    assert.match(statements[3], /checksum char\(64\) NOT NULL/iu);
    assert.match(statements[3], /applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP/iu);
    assert.match(statements[4], /^ALTER TABLE public\.schema_migrations ADD COLUMN IF NOT EXISTS checksum char\(64\)$/iu);
    assert.match(statements[5], /^SELECT version, checksum FROM public\.schema_migrations/iu);
    assert.match(statements[6], /^ALTER TABLE public\.schema_migrations ALTER COLUMN checksum SET NOT NULL$/iu);
    assert.equal(statements[7], secondSql);
    assert.match(statements[8], /^INSERT INTO public\.schema_migrations\s*\(version, checksum\)\s*VALUES\s*\(\$1, \$2\)$/iu);
    assert.deepEqual(recorder.calls[8].values, [
      '002-second.sql',
      sha256(secondSql),
    ]);
    assert.equal(statements[9], "SELECT 'third-body';");
    assert.deepEqual(recorder.calls[10].values, [
      '003-third.sql',
      sha256("SELECT 'third-body';"),
    ]);
    assert.equal(statements[11], 'COMMIT');
    assert.equal(statements.includes(firstSql), false);
    assert.deepEqual([...recorder.ledger].sort(), [
      ['001-first.sql', sha256(firstSql)],
      ['002-second.sql', sha256(secondSql)],
      ['003-third.sql', sha256("SELECT 'third-body';")],
    ]);
    assert.deepEqual(logger.entries, [
      [{ event: 'database_migration_applied', version: '002-second.sql' }],
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
      index > secondBegin && /^SELECT version, checksum FROM public\.schema_migrations/iu.test(sql)
    ));
    assert.ok(secondBegin >= 0 && secondLock > secondBegin && secondLedgerRead > secondLock);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.equal(recorder.releases, 2);
  });

  test('用 SQL 原始字节的 SHA-256 写入 ledger', async () => {
    const recorder = createRecordingPool();

    await runMigrations({
      pool: recorder.pool,
      migrations: [{ version: '001-sha.sql', sql: 'SELECT 1;' }],
      logger: createLogger(),
    });

    const insert = recorder.calls.find(({ text }) => (
      /^INSERT INTO public\.schema_migrations/iu.test(compactSql(text))
    ));
    assert.deepEqual(insert.values, [
      '001-sha.sql',
      '17db4fd369edb9244b9f91d9aeed145c3d04ad8ba6e95d06247f07a63527d11a',
    ]);
  });

  test('在同一锁事务内为旧版仅 version ledger 建立 checksum 基线', async () => {
    const sql = "SELECT 'legacy-already-applied';";
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '001-legacy.sql', checksum: null }],
    });

    const applied = await runMigrations({
      pool: recorder.pool,
      migrations: [{ version: '001-legacy.sql', sql }],
      logger: createLogger(),
    });

    assert.deepEqual(applied, []);
    const statements = recorder.calls.map(({ text }) => compactSql(text));
    const lockIndex = statements.findIndex((statement) => /pg_advisory_xact_lock/iu.test(statement));
    const addColumnIndex = statements.findIndex((statement) => (
      /^ALTER TABLE public\.schema_migrations ADD COLUMN/iu.test(statement)
    ));
    const backfillIndex = statements.findIndex((statement) => (
      /^UPDATE public\.schema_migrations SET checksum/iu.test(statement)
    ));
    const notNullIndex = statements.findIndex((statement) => (
      /^ALTER TABLE public\.schema_migrations ALTER COLUMN checksum SET NOT NULL$/iu.test(statement)
    ));
    assert.ok(lockIndex >= 0 && addColumnIndex > lockIndex);
    assert.ok(backfillIndex > addColumnIndex && notNullIndex > backfillIndex);
    assert.deepEqual(recorder.calls[backfillIndex].values, [
      sha256(sql),
      '001-legacy.sql',
    ]);
    assert.equal(statements.includes(sql), false);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.deepEqual([...recorder.ledger], [['001-legacy.sql', sha256(sql)]]);
  });

  test('旧版 ledger 缺少对应迁移文件时受控拒绝且不写入基线', async () => {
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '001-missing.sql', checksum: null }],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '002-present.sql', sql: 'SELECT 2;' }],
        logger: createLogger(),
      }),
      /旧版迁移完整性记录.*完整迁移集合/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.some((sql) => /^UPDATE public\.schema_migrations/iu.test(sql)), false);
    assert.equal(statements.includes('SELECT 2;'), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual([...recorder.ledger], [['001-missing.sql', null]]);
  });

  test('已记录 checksum 的迁移文件被删除时也拒绝继续', async () => {
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '001-deleted.sql', checksum: sha256('SELECT 1;') }],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '002-present.sql', sql: 'SELECT 2;' }],
        logger: createLogger(),
      }),
      /已应用迁移.*001-deleted\.sql.*当前迁移文件集合中缺失/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.includes('SELECT 2;'), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  });

  test('旧镜像允许完整本地前缀之后存在带 checksum 的未来迁移', async () => {
    const localSql = "SELECT 'local-applied';";
    const futureSql = "SELECT 'future-applied';";
    const recorder = createRecordingPool({
      appliedMigrations: [
        { version: '001-local.sql', checksum: sha256(localSql) },
        { version: '002-future.sql', checksum: sha256(futureSql) },
      ],
    });

    const applied = await runMigrations({
      pool: recorder.pool,
      migrations: [{ version: '001-local.sql', sql: localSql }],
      logger: createLogger(),
    });

    assert.deepEqual(applied, []);
    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.includes(localSql), false);
    assert.equal(statements.includes(futureSql), false);
    assert.equal(statements.at(-1), 'COMMIT');
    assert.deepEqual([...recorder.ledger], [
      ['001-local.sql', sha256(localSql)],
      ['002-future.sql', sha256(futureSql)],
    ]);
  });

  test('未来迁移没有 checksum 时受控拒绝且不尝试回填', async () => {
    const localSql = "SELECT 'local-applied';";
    const recorder = createRecordingPool({
      appliedMigrations: [
        { version: '001-local.sql', checksum: sha256(localSql) },
        { version: '002-future.sql', checksum: null },
      ],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '001-local.sql', sql: localSql }],
        logger: createLogger(),
      }),
      /旧版未来迁移记录缺少 checksum/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.some((sql) => /^UPDATE public\.schema_migrations/iu.test(sql)), false);
    assert.equal(statements.includes(localSql), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  });

  test('拒绝已应用本地迁移不构成连续前缀', async (t) => {
    const migrations = [
      { version: '001-first.sql', sql: "SELECT 'first';" },
      { version: '002-second.sql', sql: "SELECT 'second';" },
      { version: '003-third.sql', sql: "SELECT 'third';" },
    ];

    for (const { name, appliedMigrations } of [
      {
        name: '中间缺洞',
        appliedMigrations: [migrations[0], migrations[2]].map(({ version, sql }) => ({
          version,
          checksum: sha256(sql),
        })),
      },
      {
        name: '只记录后置版本',
        appliedMigrations: [{
          version: migrations[1].version,
          checksum: sha256(migrations[1].sql),
        }],
      },
      {
        name: '后置旧记录也不得先回填',
        appliedMigrations: [{
          version: migrations[1].version,
          checksum: null,
        }],
      },
    ]) {
      await t.test(name, async () => {
        const recorder = createRecordingPool({ appliedMigrations });

        await assert.rejects(
          runMigrations({ pool: recorder.pool, migrations, logger: createLogger() }),
          /已应用迁移必须构成本地迁移的连续前缀/u,
        );

        const statements = recorder.calls.map(({ text }) => compactSql(text));
        assert.equal(migrations.some(({ sql }) => statements.includes(sql)), false);
        assert.equal(
          statements.some((sql) => /^UPDATE public\.schema_migrations/iu.test(sql)),
          false,
        );
        assert.equal(statements.at(-1), 'ROLLBACK');
      });
    }
  });

  test('ledger 含未来版本时本地不得仍有待应用迁移', async () => {
    const firstSql = "SELECT 'first';";
    const futureSql = "SELECT 'future';";
    const recorder = createRecordingPool({
      appliedMigrations: [
        { version: '001-first.sql', checksum: sha256(firstSql) },
        { version: '003-future.sql', checksum: sha256(futureSql) },
      ],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [
          { version: '001-first.sql', sql: firstSql },
          { version: '002-pending.sql', sql: "SELECT 'must-not-run';" },
        ],
        logger: createLogger(),
      }),
      /存在未来迁移记录时.*本地迁移必须全部已应用/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.includes("SELECT 'must-not-run';"), false);
    assert.equal(statements.some((sql) => /^UPDATE public\.schema_migrations/iu.test(sql)), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
  });

  test('checksum 漂移会在任何待执行正文前失败并回滚', async () => {
    const originalSql = "SELECT 'original';";
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '002-applied.sql', checksum: sha256(originalSql) }],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [
          { version: '001-pending.sql', sql: "SELECT 'must-not-run';" },
          { version: '002-applied.sql', sql: "SELECT 'changed';" },
        ],
        logger: createLogger(),
      }),
      /SHA-256 校验和.*不一致/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.includes("SELECT 'must-not-run';"), false);
    assert.equal(statements.some((sql) => /^INSERT INTO public\.schema_migrations/iu.test(sql)), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
    assert.deepEqual([...recorder.ledger], [['002-applied.sql', sha256(originalSql)]]);
  });

  test('已应用版本的三位前缀相同但文件名变化时拒绝执行', async () => {
    const recorder = createRecordingPool({
      appliedMigrations: [{ version: '001-old-name.sql', checksum: sha256('SELECT 1;') }],
    });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [{ version: '001-new-name.sql', sql: 'SELECT 1;' }],
        logger: createLogger(),
      }),
      /迁移版本前缀.*001.*不能改名/u,
    );

    const statements = recorder.calls.map(({ text }) => compactSql(text));
    assert.equal(statements.includes('SELECT 1;'), false);
    assert.equal(statements.at(-1), 'ROLLBACK');
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

  test('后续正文失败时会回滚本次已执行正文与 ledger 写入', async () => {
    const failingSql = "SELECT 'failing-body';";
    const recorder = createRecordingPool({ failOnSql: failingSql });

    await assert.rejects(
      runMigrations({
        pool: recorder.pool,
        migrations: [
          { version: '001-first.sql', sql: "SELECT 'successful-body';" },
          { version: '002-failing.sql', sql: failingSql },
        ],
        logger: createLogger(),
      }),
      /migration-secret/u,
    );

    assert.deepEqual([...recorder.ledger], []);
    assert.equal(compactSql(recorder.calls.at(-1).text), 'ROLLBACK');
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

  test('release 失败不覆盖原始迁移错误，成功路径则传播 release 错误', async (t) => {
    await t.test('保留原始迁移错误', async () => {
      const sensitiveSql = "SELECT 'migration-body-secret';";
      const recorder = createRecordingPool({ failOnSql: sensitiveSql, failOnRelease: true });

      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '001-failing.sql', sql: sensitiveSql }],
          logger: createLogger(),
        }),
        /migration-secret/u,
      );
      assert.equal(recorder.releases, 1);
    });

    await t.test('无更早错误时传播 release 错误', async () => {
      const recorder = createRecordingPool({ failOnRelease: true });

      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '001-success.sql', sql: 'SELECT 1;' }],
          logger: createLogger(),
        }),
        (error) => error === recorder.releaseError,
      );
      assert.equal(compactSql(recorder.calls.at(-1).text), 'COMMIT');
      assert.equal(recorder.releases, 1);
    });
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

    await t.test('SQL 只含空白', async () => {
      await assert.rejects(
        runMigrations({
          pool: recorder.pool,
          migrations: [{ version: '001-blank.sql', sql: ' \n\t\uFEFF' }],
        }),
        /迁移.*SQL.*不能为空/u,
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
