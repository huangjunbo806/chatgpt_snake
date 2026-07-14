import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import { DUMMY_PASSWORD, startServer } from '../../server/start.js';

const CONFIG = Object.freeze({
  nodeEnv: 'test',
  host: '127.0.0.1',
  port: 3210,
  databaseUrl: 'postgresql://snake:database-secret@db.example.test/snake',
  sessionSecret: 'session-secret-that-is-long-enough-123456789',
  publicOrigin: 'http://127.0.0.1:3210',
  staticRoot: '/tmp/docker-snake-client',
  trustProxy: 0,
});

function createProcessLike() {
  const processLike = new EventEmitter();
  processLike.exitCode = undefined;
  return processLike;
}

function createHappyHarness() {
  const calls = [];
  const captured = {};
  const env = { marker: 'env' };
  const processLike = createProcessLike();
  const pool = {
    async end() {
      calls.push('pool.end');
    },
  };
  const healthCheck = async () => {
    calls.push('healthCheck');
    return true;
  };
  const passwordService = {
    async hash(password) {
      calls.push('passwordService.hash');
      captured.dummyPassword = password;
      return 'dummy-password-hash';
    },
    async verify() {
      return false;
    },
  };
  const store = { marker: 'session-store' };
  const sessionMiddleware = () => {};
  const userRepository = { marker: 'user-repository' };
  const leaderboardRepository = { marker: 'leaderboard-repository' };
  const authService = { marker: 'auth-service' };
  const leaderboardService = { marker: 'leaderboard-service' };
  const authThrottle = { marker: 'auth-throttle' };
  const scoreThrottle = { marker: 'score-throttle' };
  const authRouter = { marker: 'auth-router' };
  const scoresRouter = { marker: 'scores-router' };
  const leaderboardRouter = { marker: 'leaderboard-router' };
  const app = { marker: 'app' };
  const server = {
    marker: 'server',
    listening: true,
    close(callback) {
      this.listening = false;
      callback();
    },
  };
  const close = () => Promise.resolve();
  const logger = {
    entries: [],
    info(entry) {
      calls.push('logger.info');
      this.entries.push(entry);
    },
  };

  const dependencies = {
    loadConfig(receivedEnv) {
      calls.push('loadConfig');
      captured.env = receivedEnv;
      return CONFIG;
    },
    createPool(options) {
      calls.push('createPool');
      captured.createPool = options;
      return pool;
    },
    createDatabaseHealthCheck(options) {
      calls.push('createDatabaseHealthCheck');
      captured.healthFactory = options;
      return healthCheck;
    },
    async waitForDatabase(options) {
      calls.push('waitForDatabase');
      captured.wait = options;
      return options.healthCheck();
    },
    async runMigrations(options) {
      calls.push('runMigrations');
      captured.migrations = options;
    },
    createPasswordService() {
      calls.push('createPasswordService');
      return passwordService;
    },
    createPostgresSessionStore(options) {
      calls.push('createPostgresSessionStore');
      captured.store = options;
      return store;
    },
    createSessionMiddleware(options) {
      calls.push('createSessionMiddleware');
      captured.session = options;
      return sessionMiddleware;
    },
    createUserRepository(options) {
      calls.push('createUserRepository');
      captured.userRepository = options;
      return userRepository;
    },
    createLeaderboardRepository(options) {
      calls.push('createLeaderboardRepository');
      captured.leaderboardRepository = options;
      return leaderboardRepository;
    },
    createAuthService(options) {
      calls.push('createAuthService');
      captured.authService = options;
      return authService;
    },
    createLeaderboardService(options) {
      calls.push('createLeaderboardService');
      captured.leaderboardService = options;
      return leaderboardService;
    },
    createAuthThrottle(options) {
      calls.push('createAuthThrottle');
      captured.authThrottle = options;
      return authThrottle;
    },
    createScoreThrottle(options) {
      calls.push('createScoreThrottle');
      captured.scoreThrottle = options;
      return scoreThrottle;
    },
    createAuthRouter(options) {
      calls.push('createAuthRouter');
      captured.authRouter = options;
      return authRouter;
    },
    createScoresRouter(options) {
      calls.push('createScoresRouter');
      captured.scoresRouter = options;
      return scoresRouter;
    },
    createLeaderboardRouter(options) {
      calls.push('createLeaderboardRouter');
      captured.leaderboardRouter = options;
      return leaderboardRouter;
    },
    createApp(options) {
      calls.push('createApp');
      captured.app = options;
      return app;
    },
    async listenForConnections(options) {
      calls.push('listenForConnections');
      captured.listen = options;
      return server;
    },
    createServerLifecycle(options) {
      calls.push('createServerLifecycle');
      captured.lifecycle = options;
      return {
        close,
        installSignalHandlers() {
          calls.push('installSignalHandlers');
        },
      };
    },
  };

  return {
    app,
    authRouter,
    authService,
    authThrottle,
    calls,
    captured,
    close,
    dependencies,
    env,
    healthCheck,
    leaderboardRepository,
    leaderboardRouter,
    leaderboardService,
    logger,
    passwordService,
    pool,
    processLike,
    scoreThrottle,
    scoresRouter,
    server,
    sessionMiddleware,
    store,
    userRepository,
  };
}

describe('startServer 依赖装配', () => {
  test('严格按启动顺序装配同一 pool、一次 dummy hash、路由与健康检查', async () => {
    const harness = createHappyHarness();

    const runtime = await startServer({
      env: harness.env,
      logger: harness.logger,
      processLike: harness.processLike,
      dependencies: harness.dependencies,
    });

    assert.deepEqual(harness.calls, [
      'loadConfig',
      'createPool',
      'createDatabaseHealthCheck',
      'waitForDatabase',
      'healthCheck',
      'runMigrations',
      'createPasswordService',
      'passwordService.hash',
      'createPostgresSessionStore',
      'createSessionMiddleware',
      'createUserRepository',
      'createLeaderboardRepository',
      'createAuthService',
      'createLeaderboardService',
      'createAuthThrottle',
      'createScoreThrottle',
      'createAuthRouter',
      'createScoresRouter',
      'createLeaderboardRouter',
      'createApp',
      'listenForConnections',
      'createServerLifecycle',
      'installSignalHandlers',
      'logger.info',
    ]);
    assert.equal(harness.captured.env, harness.env);
    assert.equal(harness.captured.createPool.databaseUrl, CONFIG.databaseUrl);
    assert.equal(harness.captured.createPool.logger, harness.logger);
    assert.equal(harness.captured.healthFactory.pool, harness.pool);
    assert.equal(harness.captured.wait.healthCheck, harness.healthCheck);
    assert.equal(harness.captured.wait.logger, harness.logger);
    assert.equal(harness.captured.migrations.pool, harness.pool);
    assert.equal(harness.captured.migrations.logger, harness.logger);
    assert.equal(harness.captured.dummyPassword, DUMMY_PASSWORD);
    assert.notEqual(DUMMY_PASSWORD, CONFIG.databaseUrl);
    assert.notEqual(DUMMY_PASSWORD, CONFIG.sessionSecret);
    assert.deepEqual(harness.captured.store, { pool: harness.pool, logger: harness.logger });
    assert.deepEqual(harness.captured.session, { store: harness.store, config: CONFIG });
    assert.deepEqual(harness.captured.userRepository, { pool: harness.pool });
    assert.deepEqual(harness.captured.leaderboardRepository, { pool: harness.pool });
    assert.deepEqual(harness.captured.authService, {
      userRepository: harness.userRepository,
      passwordService: harness.passwordService,
      dummyPasswordHash: 'dummy-password-hash',
    });
    assert.deepEqual(harness.captured.leaderboardService, {
      repository: harness.leaderboardRepository,
    });
    assert.deepEqual(harness.captured.authThrottle, {});
    assert.deepEqual(harness.captured.scoreThrottle, {});
    assert.deepEqual(harness.captured.authRouter, {
      authService: harness.authService,
      authThrottle: harness.authThrottle,
    });
    assert.deepEqual(harness.captured.scoresRouter, {
      service: harness.leaderboardService,
      throttle: harness.scoreThrottle,
    });
    assert.deepEqual(harness.captured.leaderboardRouter, {
      service: harness.leaderboardService,
    });
    assert.equal(harness.captured.app.config, CONFIG);
    assert.equal(harness.captured.app.healthCheck, harness.healthCheck);
    assert.equal(harness.captured.app.sessionMiddleware, harness.sessionMiddleware);
    assert.equal(harness.captured.app.logger, harness.logger);
    assert.deepEqual(harness.captured.app.routers, [
      { path: '/api/auth', router: harness.authRouter },
      { path: '/api/scores', router: harness.scoresRouter },
      { path: '/api/leaderboard', router: harness.leaderboardRouter },
    ]);
    assert.deepEqual(harness.captured.listen, {
      app: harness.app,
      port: CONFIG.port,
      host: CONFIG.host,
    });
    assert.deepEqual(harness.captured.lifecycle, {
      server: harness.server,
      pool: harness.pool,
      processLike: harness.processLike,
      logger: harness.logger,
    });
    assert.deepEqual(harness.logger.entries, [{
      event: 'server_started',
      host: CONFIG.host,
      port: CONFIG.port,
      environment: CONFIG.nodeEnv,
    }]);
    assert.doesNotMatch(
      inspect(harness.logger.entries),
      /database-secret|session-secret|postgresql/iu,
    );
    assert.equal(Object.isFrozen(runtime), true);
    assert.deepEqual(runtime, {
      app: harness.app,
      server: harness.server,
      close: harness.close,
    });
  });

  test('安全启动日志器抛错不使已监听服务启动失败', async () => {
    const harness = createHappyHarness();
    const logger = {};
    Object.defineProperty(logger, 'info', {
      get() {
        throw new Error('logger-secret');
      },
    });

    const runtime = await startServer({
      env: harness.env,
      logger,
      processLike: harness.processLike,
      dependencies: harness.dependencies,
    });

    assert.equal(runtime.server, harness.server);
  });
});

function createFailureHarness(failAt, { poolEndError = null } = {}) {
  const calls = [];
  const startupError = new Error(`startup-${failAt}-secret`);
  const pool = {
    async end() {
      calls.push('pool.end');
      if (poolEndError) {
        throw poolEndError;
      }
    },
  };
  const server = {
    listening: true,
    close(callback) {
      calls.push('server.close');
      this.listening = false;
      callback();
    },
  };
  const step = (name, value) => {
    calls.push(name);
    if (failAt === name) {
      throw startupError;
    }
    return value;
  };
  const passwordService = {
    async hash() {
      return step('passwordService.hash', 'dummy-hash');
    },
    async verify() {
      return false;
    },
  };
  const dependencies = {
    loadConfig: () => step('loadConfig', CONFIG),
    createPool: () => step('createPool', pool),
    createDatabaseHealthCheck: () => step('createDatabaseHealthCheck', async () => true),
    waitForDatabase: async () => step('waitForDatabase', true),
    runMigrations: async () => step('runMigrations'),
    createPasswordService: () => step('createPasswordService', passwordService),
    createPostgresSessionStore: () => step('createPostgresSessionStore', {}),
    createSessionMiddleware: () => step('createSessionMiddleware', () => {}),
    createUserRepository: () => step('createUserRepository', {}),
    createLeaderboardRepository: () => step('createLeaderboardRepository', {}),
    createAuthService: () => step('createAuthService', {}),
    createLeaderboardService: () => step('createLeaderboardService', {}),
    createAuthThrottle: () => step('createAuthThrottle', {}),
    createScoreThrottle: () => step('createScoreThrottle', {}),
    createAuthRouter: () => step('createAuthRouter', {}),
    createScoresRouter: () => step('createScoresRouter', {}),
    createLeaderboardRouter: () => step('createLeaderboardRouter', {}),
    createApp: () => step('createApp', {}),
    listenForConnections: async () => step('listenForConnections', server),
    createServerLifecycle: () => step('createServerLifecycle', {
      close() {
        calls.push('lifecycle.close');
        return new Promise((resolve, reject) => {
          server.close(async (serverError) => {
            try {
              await pool.end();
              if (serverError) {
                reject(serverError);
                return;
              }
              resolve();
            } catch (error) {
              reject(error);
            }
          });
        });
      },
      installSignalHandlers() {
        step('installSignalHandlers');
      },
    }),
  };

  return { calls, dependencies, pool, server, startupError };
}

describe('startServer 启动失败清理', () => {
  const beforePoolStages = ['loadConfig', 'createPool'];
  const afterPoolStages = [
    'createDatabaseHealthCheck',
    'waitForDatabase',
    'runMigrations',
    'createPasswordService',
    'passwordService.hash',
    'createPostgresSessionStore',
    'createSessionMiddleware',
    'createUserRepository',
    'createLeaderboardRepository',
    'createAuthService',
    'createLeaderboardService',
    'createAuthThrottle',
    'createScoreThrottle',
    'createAuthRouter',
    'createScoresRouter',
    'createLeaderboardRouter',
    'createApp',
    'listenForConnections',
    'createServerLifecycle',
    'installSignalHandlers',
  ];

  for (const stage of beforePoolStages) {
    test(`${stage} 失败时尚无可清理 pool`, async () => {
      const harness = createFailureHarness(stage);

      await assert.rejects(
        startServer({ dependencies: harness.dependencies }),
        (error) => error === harness.startupError,
      );

      assert.equal(harness.calls.filter((call) => call === 'pool.end').length, 0);
    });
  }

  for (const stage of afterPoolStages) {
    test(`${stage} 失败时恰好结束一次 pool`, async () => {
      const harness = createFailureHarness(stage);

      await assert.rejects(
        startServer({
          processLike: createProcessLike(),
          dependencies: harness.dependencies,
        }),
        (error) => error === harness.startupError,
      );

      assert.equal(harness.calls.filter((call) => call === 'pool.end').length, 1);
      if (stage === 'createServerLifecycle') {
        assert.equal(harness.calls.filter((call) => call === 'server.close').length, 1);
      }
      if (stage === 'installSignalHandlers') {
        assert.equal(harness.calls.filter((call) => call === 'lifecycle.close').length, 1);
      }
    });
  }

  test('pool 清理也失败时用 AggregateError 保留原启动错误与清理错误', async () => {
    const poolEndError = new Error('pool-cleanup-secret');
    const harness = createFailureHarness('runMigrations', { poolEndError });

    await assert.rejects(
      startServer({ dependencies: harness.dependencies }),
      (error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(error.errors, [harness.startupError, poolEndError]);
        assert.equal(error.cause, harness.startupError);
        assert.equal(error.message, '服务启动失败且资源清理失败');
        return true;
      },
    );
  });
});
