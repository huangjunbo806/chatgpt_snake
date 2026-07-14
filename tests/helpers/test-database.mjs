import pg from 'pg';

const { Pool } = pg;
const testPoolIdentities = new WeakMap();

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
  let userName;
  try {
    databaseName = decodeURIComponent(parsed.pathname.slice(1));
    userName = decodeURIComponent(parsed.username);
  } catch {
    throw new Error('TEST_DATABASE_URL 必须包含有效的数据库名和用户');
  }

  if (!databaseName || databaseName.includes('/')) {
    throw new Error('TEST_DATABASE_URL 必须包含有效的数据库名');
  }
  if (!userName) {
    throw new Error('TEST_DATABASE_URL 必须显式包含数据库用户');
  }

  return { databaseName, userName };
}

function isSafeDatabaseName(databaseName) {
  return typeof databaseName === 'string'
    && /(?:_test|-test)$/u.test(databaseName);
}

function parseSafeTestDatabaseIdentity(databaseUrl) {
  const identity = parseTestDatabaseUrl(databaseUrl);
  if (!isSafeDatabaseName(identity.databaseName)) {
    throw new Error('TEST_DATABASE_URL 的数据库名必须以 _test 或 -test 结尾');
  }
  return Object.freeze(identity);
}

export function getTestDatabaseUrl(env = process.env) {
  const databaseUrl = env.TEST_DATABASE_URL;
  return typeof databaseUrl === 'string' && databaseUrl.trim() ? databaseUrl : null;
}

export function assertSafeTestDatabaseUrl(databaseUrl) {
  parseSafeTestDatabaseIdentity(databaseUrl);
  return databaseUrl;
}

export function createTestPool({
  databaseUrl = getTestDatabaseUrl(),
  PoolImpl = Pool,
} = {}) {
  const identity = parseSafeTestDatabaseIdentity(databaseUrl);
  const pool = new PoolImpl({ connectionString: databaseUrl });
  testPoolIdentities.set(pool, identity);
  return pool;
}

export async function resetTestDatabase({ pool } = {}) {
  const expectedIdentity = testPoolIdentities.get(pool);
  if (!expectedIdentity) {
    throw new Error('resetTestDatabase 的 pool 必须由 createTestPool 创建');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new Error('resetTestDatabase 需要可连接的测试 pool');
  }

  const client = await pool.connect();
  let transactionStarted = false;
  let operationError;
  let releaseError;

  try {
    const identityResult = await client.query(
      'SELECT pg_catalog.current_database() AS database_name, session_user AS user_name',
    );
    const actualIdentity = identityResult.rows[0];
    if (
      !isSafeDatabaseName(actualIdentity?.database_name)
      || actualIdentity.database_name !== expectedIdentity.databaseName
      || actualIdentity.user_name !== expectedIdentity.userName
    ) {
      throw new Error('Pool 实际连接身份与已验证的 TEST_DATABASE_URL 不匹配');
    }

    transactionStarted = true;
    await client.query('BEGIN');
    await client.query('DROP TABLE IF EXISTS public.user_sessions');
    await client.query('DROP TABLE IF EXISTS public.users');
    await client.query('DROP TABLE IF EXISTS public.schema_migrations');
    await client.query('COMMIT');
    transactionStarted = false;
  } catch (error) {
    operationError = error;
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
    try {
      client.release(releaseError);
    } catch (error) {
      if (!operationError) {
        throw error;
      }
    }
  }
}

export async function closeTestPool(pool) {
  if (!pool || typeof pool.end !== 'function') {
    throw new Error('closeTestPool 需要可关闭的测试 pool');
  }

  try {
    await pool.end();
  } finally {
    testPoolIdentities.delete(pool);
  }
}
