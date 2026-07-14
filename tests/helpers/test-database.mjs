import pg from 'pg';

const { Pool } = pg;

function parseTestDatabaseUrl(databaseUrl) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('TEST_DATABASE_URL 未配置');
  }

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL 必须是有效的 PostgreSQL URL');
  }

  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('TEST_DATABASE_URL 必须是有效的 PostgreSQL URL');
  }

  let databaseName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
  } catch {
    throw new Error('TEST_DATABASE_URL 必须包含有效的数据库名');
  }

  if (!databaseName || databaseName.includes('/')) {
    throw new Error('TEST_DATABASE_URL 必须包含有效的数据库名');
  }

  return { databaseName };
}

function isSafeDatabaseName(databaseName) {
  return typeof databaseName === 'string'
    && (databaseName.includes('_test') || databaseName.includes('-test'));
}

export function getTestDatabaseUrl(env = process.env) {
  const databaseUrl = env.TEST_DATABASE_URL;
  return typeof databaseUrl === 'string' && databaseUrl.trim() ? databaseUrl : null;
}

export function assertSafeTestDatabaseUrl(databaseUrl) {
  const { databaseName } = parseTestDatabaseUrl(databaseUrl);
  if (!isSafeDatabaseName(databaseName)) {
    throw new Error('TEST_DATABASE_URL 必须指向名称包含 _test 或 -test 的测试数据库');
  }

  return databaseUrl;
}

export function createTestPool({
  databaseUrl = getTestDatabaseUrl(),
  PoolImpl = Pool,
} = {}) {
  assertSafeTestDatabaseUrl(databaseUrl);
  return new PoolImpl({ connectionString: databaseUrl });
}

export async function resetTestDatabase({ pool, databaseUrl = getTestDatabaseUrl() } = {}) {
  const { databaseName: expectedDatabaseName } = parseTestDatabaseUrl(databaseUrl);
  if (!isSafeDatabaseName(expectedDatabaseName)) {
    throw new Error('TEST_DATABASE_URL 必须指向名称包含 _test 或 -test 的测试数据库');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('resetTestDatabase 需要可连接的测试 pool');
  }

  const client = await pool.connect();
  let transactionStarted = false;
  let releaseError;

  try {
    const databaseResult = await client.query('SELECT current_database() AS database_name');
    const actualDatabaseName = databaseResult.rows[0]?.database_name;
    if (!isSafeDatabaseName(actualDatabaseName) || actualDatabaseName !== expectedDatabaseName) {
      throw new Error('Pool 实际连接的测试数据库与 TEST_DATABASE_URL 不匹配');
    }

    await client.query('BEGIN');
    transactionStarted = true;
    await client.query('DROP SCHEMA public CASCADE');
    await client.query('CREATE SCHEMA public');
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        // 保留触发测试数据库重置失败的原始异常。
        releaseError = rollbackError;
      }
    }
    throw error;
  } finally {
    client.release(releaseError);
  }
}

export async function closeTestPool(pool) {
  if (!pool || typeof pool.end !== 'function') {
    throw new Error('closeTestPool 需要可关闭的测试 pool');
  }

  await pool.end();
}
