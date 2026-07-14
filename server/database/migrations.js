import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const MIGRATION_FILENAME_PATTERN = /^\d{3}-[a-z0-9-]+\.sql$/u;
const MIGRATION_CHECKSUM_PATTERN = /^[0-9a-f]{64}$/u;
const ADVISORY_LOCK_KEY = 'docker_snake:schema-migrations';
export const DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS = 30_000;

function compareVersions(left, right) {
  if (left.version < right.version) {
    return -1;
  }
  if (left.version > right.version) {
    return 1;
  }
  return 0;
}

function validateMigration(migration) {
  if (!migration || typeof migration !== 'object') {
    throw new Error('迁移条目必须是包含 version 与 sql 的对象');
  }

  const { version, sql } = migration;
  if (typeof version !== 'string' || !MIGRATION_FILENAME_PATTERN.test(version)) {
    throw new Error(`迁移文件名 ${String(version)} 不合法，必须使用三位版本号与小写连字符名称`);
  }
  if (typeof sql !== 'string') {
    throw new Error(`迁移 ${version} 的 SQL 必须是字符串`);
  }
  if (!sql.trim()) {
    throw new Error(`迁移 ${version} 的 SQL 不能为空`);
  }

  return Object.freeze({ version, sql });
}

function checksumMigration(sql) {
  return createHash('sha256').update(sql, 'utf8').digest('hex');
}

function readAppliedMigrations(rows) {
  const appliedByPrefix = new Map();

  for (const row of rows) {
    if (
      !row
      || typeof row.version !== 'string'
      || !MIGRATION_FILENAME_PATTERN.test(row.version)
      || (
        row.checksum !== null
        && (typeof row.checksum !== 'string' || !MIGRATION_CHECKSUM_PATTERN.test(row.checksum))
      )
    ) {
      throw new Error('public.schema_migrations 包含无效的迁移完整性记录');
    }

    const prefix = row.version.slice(0, 3);
    if (appliedByPrefix.has(prefix)) {
      throw new Error(`public.schema_migrations 的迁移版本前缀 ${prefix} 重复`);
    }
    appliedByPrefix.set(prefix, Object.freeze({
      version: row.version,
      checksum: row.checksum,
    }));
  }

  return appliedByPrefix;
}

function verifyAppliedMigrations(migrations, appliedByPrefix) {
  const migrationsByPrefix = new Map(migrations.map((migration) => (
    [migration.version.slice(0, 3), migration]
  )));
  const checksumBackfills = [];

  for (const [prefix, applied] of appliedByPrefix) {
    const migration = migrationsByPrefix.get(prefix);
    if (!migration) {
      if (applied.checksum === null) {
        throw new Error('旧版迁移完整性记录无法升级，必须提供包含全部已应用版本的完整迁移集合');
      }
      throw new Error(`已应用迁移 ${applied.version} 在当前迁移文件集合中缺失`);
    }
    if (applied.version !== migration.version) {
      throw new Error(`迁移版本前缀 ${prefix} 已应用，迁移文件不能改名`);
    }
    if (applied.checksum === null) {
      checksumBackfills.push(migration);
    } else if (applied.checksum !== migration.checksum) {
      throw new Error(`迁移 ${migration.version} 的 SHA-256 校验和与已应用记录不一致`);
    }
  }

  return checksumBackfills;
}

function validateAndSortMigrations(migrations) {
  if (!Array.isArray(migrations)) {
    throw new Error('migrations 必须是迁移数组');
  }

  const normalized = Array.from(migrations, validateMigration).sort(compareVersions);
  const prefixes = new Set();

  for (const migration of normalized) {
    const prefix = migration.version.slice(0, 3);
    if (prefixes.has(prefix)) {
      throw new Error(`迁移版本前缀 ${prefix} 重复`);
    }
    prefixes.add(prefix);
  }

  return Object.freeze(normalized);
}

function safeLog(logger, level, entry) {
  try {
    const log = logger?.[level];
    if (typeof log === 'function') {
      log.call(logger, entry);
    }
  } catch {
    // 日志系统故障不能改变迁移事务的结果。
  }
}

export async function loadMigrations({ migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const filenames = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();

  for (const filename of filenames) {
    if (!MIGRATION_FILENAME_PATTERN.test(filename)) {
      throw new Error(`迁移文件名 ${filename} 不合法，必须使用三位版本号与小写连字符名称`);
    }
  }

  const migrations = await Promise.all(filenames.map(async (version) => ({
    version,
    sql: await readFile(path.join(migrationsDir, version), 'utf8'),
  })));

  return validateAndSortMigrations(migrations);
}

export async function runMigrations({ pool, migrations, logger = console } = {}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('runMigrations 需要可连接的 pool');
  }

  const usesDefaultMigrations = migrations === undefined;
  const normalizedMigrations = validateAndSortMigrations(
    usesDefaultMigrations ? await loadMigrations() : migrations,
  );
  const checksummedMigrations = normalizedMigrations.map((migration) => Object.freeze({
    ...migration,
    checksum: checksumMigration(migration.sql),
  }));
  const client = await pool.connect();
  const newlyApplied = [];
  let releaseError;

  try {
    await client.query('BEGIN');
    await client.query(
      "SELECT set_config('statement_timeout', $1, true)",
      [`${DATABASE_MIGRATION_STATEMENT_TIMEOUT_MS}ms`],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [ADVISORY_LOCK_KEY],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version varchar(255) PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(
      'ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum char(64)',
    );

    const ledgerResult = await client.query(
      'SELECT version, checksum FROM public.schema_migrations',
    );
    const appliedByPrefix = readAppliedMigrations(ledgerResult.rows);
    const checksumBackfills = verifyAppliedMigrations(checksummedMigrations, appliedByPrefix);

    // 旧 runner 只记录 version。精确匹配文件名后，在同一锁事务内建立一次性校验基线。
    for (const migration of checksumBackfills) {
      const updateResult = await client.query(
        `
          UPDATE public.schema_migrations
          SET checksum = $1
          WHERE version = $2 AND checksum IS NULL
        `,
        [migration.checksum, migration.version],
      );
      if (updateResult.rowCount !== 1) {
        throw new Error('旧版迁移完整性记录在升级期间发生变化');
      }
    }
    await client.query(
      'ALTER TABLE public.schema_migrations ALTER COLUMN checksum SET NOT NULL',
    );

    for (const migration of checksummedMigrations) {
      if (appliedByPrefix.has(migration.version.slice(0, 3))) {
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        'INSERT INTO public.schema_migrations (version, checksum) VALUES ($1, $2)',
        [migration.version, migration.checksum],
      );
      newlyApplied.push(migration.version);
    }

    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      // 保留触发迁移失败的原始异常。
      releaseError = rollbackError;
    }
    safeLog(logger, 'error', { event: 'database_migration_failed' });
    throw error;
  } finally {
    client.release(releaseError);
  }

  for (const version of newlyApplied) {
    safeLog(logger, 'info', { event: 'database_migration_applied', version });
  }

  return newlyApplied;
}
