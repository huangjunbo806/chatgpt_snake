import connectPgSimple from 'connect-pg-simple';
import session from 'express-session';

const PostgresSessionStore = connectPgSimple(session);

function createErrorLog(logger) {
  return function errorLog() {
    try {
      const logError = logger?.error;
      if (typeof logError === 'function') {
        logError.call(logger, { event: 'session_store_error' });
      }
    } catch {
      // 日志系统故障不能从 Store 的错误回调继续传播。
    }
  };
}

export function createPostgresSessionStore({
  pool,
  logger = console,
  StoreClass = PostgresSessionStore,
} = {}) {
  if (!pool) {
    throw new Error('createPostgresSessionStore 需要 pool');
  }

  return new StoreClass({
    pool,
    schemaName: 'public',
    tableName: 'user_sessions',
    createTableIfMissing: false,
    disableTouch: true,
    pruneSessionInterval: 900,
    errorLog: createErrorLog(logger),
  });
}
