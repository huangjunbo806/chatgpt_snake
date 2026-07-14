import pg from 'pg';

const { Pool } = pg;

export const DATABASE_CONNECTION_TIMEOUT_MS = 5_000;
export const DATABASE_HEALTH_QUERY_TIMEOUT_MS = 2_000;

function safeLogIdleError(logger) {
  try {
    const logError = logger?.error;
    if (typeof logError === 'function') {
      logError.call(logger, { event: 'database_pool_idle_error' });
    }
  } catch {
    // 日志系统故障不能导致进程因空闲连接错误再次失败。
  }
}

export function createPool({ databaseUrl, PoolImpl = Pool, logger = console } = {}) {
  if (typeof databaseUrl !== 'string' || !databaseUrl.trim()) {
    throw new Error('createPool 的 databaseUrl 不能为空');
  }

  const pool = new PoolImpl({
    connectionString: databaseUrl,
    connectionTimeoutMillis: DATABASE_CONNECTION_TIMEOUT_MS,
  });
  pool.on('error', () => {
    safeLogIdleError(logger);
  });

  return pool;
}

export function createDatabaseHealthCheck({ pool } = {}) {
  if (!pool || typeof pool.query !== 'function') {
    throw new Error('createDatabaseHealthCheck 需要可查询的 pool');
  }

  return async function databaseHealthCheck() {
    await pool.query({
      text: 'SELECT 1',
      query_timeout: DATABASE_HEALTH_QUERY_TIMEOUT_MS,
    });
    return true;
  };
}
