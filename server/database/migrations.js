import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL('../../db/migrations/', import.meta.url));
const MIGRATION_FILENAME_PATTERN = /^\d{3}-[a-z0-9-]+\.sql$/u;
const ADVISORY_LOCK_KEY = 'docker_snake:schema-migrations';

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

  return Object.freeze({ version, sql });
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

  const normalizedMigrations = validateAndSortMigrations(
    migrations === undefined ? await loadMigrations() : migrations,
  );
  const client = await pool.connect();
  const newlyApplied = [];
  let releaseError;

  try {
    await client.query('BEGIN');
    await client.query(
      'SELECT pg_advisory_xact_lock(hashtext($1))',
      [ADVISORY_LOCK_KEY],
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version varchar(255) PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const ledgerResult = await client.query('SELECT version FROM schema_migrations');
    const appliedVersions = new Set(ledgerResult.rows.map(({ version }) => version));

    for (const migration of normalizedMigrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      await client.query(migration.sql);
      await client.query(
        'INSERT INTO schema_migrations (version) VALUES ($1)',
        [migration.version],
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
