import { pathToFileURL } from 'node:url';

import { createApp } from './app.js';
import { createPasswordService } from './auth/password.js';
import { createSessionMiddleware } from './auth/session.js';
import { loadConfig } from './config.js';
import { runMigrations } from './database/migrations.js';
import { createDatabaseHealthCheck, createPool } from './database/pool.js';
import { createPostgresSessionStore } from './database/session-store.js';
import { waitForDatabase } from './database/wait-for-database.js';
import {
  createServerLifecycle,
  listenForConnections,
} from './http/server-lifecycle.js';
import { createLeaderboardRepository } from './repositories/leaderboard-repository.js';
import { createUserRepository } from './repositories/user-repository.js';
import { createAuthRouter } from './routes/auth.js';
import { createLeaderboardRouter } from './routes/leaderboard.js';
import { createScoresRouter } from './routes/scores.js';
import { createAuthThrottle } from './security/auth-throttle.js';
import { createScoreThrottle } from './security/score-throttle.js';
import { createAuthService } from './services/auth-service.js';
import { createLeaderboardService } from './services/leaderboard-service.js';

export const DUMMY_PASSWORD = 'docker-snake-dummy-password-v1';

const defaultDependencies = Object.freeze({
  createApp,
  createAuthRouter,
  createAuthService,
  createAuthThrottle,
  createDatabaseHealthCheck,
  createLeaderboardRepository,
  createLeaderboardRouter,
  createLeaderboardService,
  createPasswordService,
  createPool,
  createPostgresSessionStore,
  createScoreThrottle,
  createScoresRouter,
  createServerLifecycle,
  createSessionMiddleware,
  createUserRepository,
  listenForConnections,
  loadConfig,
  runMigrations,
  waitForDatabase,
});

function safeInfo(logger, entry) {
  try {
    const info = logger?.info;
    if (typeof info === 'function') {
      info.call(logger, entry);
    }
  } catch {
    // 日志系统故障不能让已经监听的服务变成启动失败。
  }
}

function combineStartupAndCleanupErrors(startupError, cleanupError) {
  return new AggregateError(
    [startupError, cleanupError],
    '服务启动失败且资源清理失败',
    { cause: startupError },
  );
}

async function cleanupAfterStartupFailure({ lifecycle, server, pool }) {
  if (lifecycle) {
    await lifecycle.close();
    return;
  }

  const errors = [];
  if (server?.close) {
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    } catch (error) {
      errors.push(error);
    }
  }
  try {
    await pool.end();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, '服务启动资源清理失败');
  }
}

export async function startServer({
  env = process.env,
  logger = console,
  processLike = process,
  dependencies = defaultDependencies,
} = {}) {
  let pool;
  let server;
  let lifecycle;

  try {
    const config = dependencies.loadConfig(env);
    pool = dependencies.createPool({ databaseUrl: config.databaseUrl, logger });
    const healthCheck = dependencies.createDatabaseHealthCheck({ pool });
    await dependencies.waitForDatabase({ healthCheck, logger });
    await dependencies.runMigrations({ pool, logger });

    const passwordService = dependencies.createPasswordService();
    const dummyPasswordHash = await passwordService.hash(DUMMY_PASSWORD);
    const store = dependencies.createPostgresSessionStore({ pool, logger });
    const sessionMiddleware = dependencies.createSessionMiddleware({ store, config });
    const userRepository = dependencies.createUserRepository({ pool });
    const leaderboardRepository = dependencies.createLeaderboardRepository({ pool });
    const authService = dependencies.createAuthService({
      userRepository,
      passwordService,
      dummyPasswordHash,
    });
    const leaderboardService = dependencies.createLeaderboardService({
      repository: leaderboardRepository,
    });
    const authThrottle = dependencies.createAuthThrottle({});
    const scoreThrottle = dependencies.createScoreThrottle({});
    const authRouter = dependencies.createAuthRouter({ authService, authThrottle });
    const scoresRouter = dependencies.createScoresRouter({
      service: leaderboardService,
      throttle: scoreThrottle,
    });
    const leaderboardRouter = dependencies.createLeaderboardRouter({
      service: leaderboardService,
    });
    const app = dependencies.createApp({
      config,
      healthCheck,
      sessionMiddleware,
      routers: [
        { path: '/api/auth', router: authRouter },
        { path: '/api/scores', router: scoresRouter },
        { path: '/api/leaderboard', router: leaderboardRouter },
      ],
      logger,
    });

    server = await dependencies.listenForConnections({
      app,
      port: config.port,
      host: config.host,
    });
    lifecycle = dependencies.createServerLifecycle({
      server,
      pool,
      processLike,
      logger,
    });
    lifecycle.installSignalHandlers();

    safeInfo(logger, {
      event: 'server_started',
      host: config.host,
      port: config.port,
      environment: config.nodeEnv,
    });

    return Object.freeze({ app, server, close: lifecycle.close });
  } catch (startupError) {
    if (!pool) {
      throw startupError;
    }

    try {
      await cleanupAfterStartupFailure({ lifecycle, server, pool });
    } catch (cleanupError) {
      throw combineStartupAndCleanupErrors(startupError, cleanupError);
    }
    throw startupError;
  }
}

function isDirectRun(argv = process.argv) {
  if (!argv[1]) {
    return false;
  }

  try {
    return pathToFileURL(argv[1]).href === import.meta.url;
  } catch {
    return false;
  }
}

async function runCli() {
  await import('dotenv/config');
  await startServer();
}

if (isDirectRun()) {
  runCli().catch(() => {
    try {
      console.error({ event: 'server_start_failed' });
    } catch {
      // 失败日志也必须避免二次异常。
    }
    process.exitCode = 1;
  });
}
