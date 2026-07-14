import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import session from 'express-session';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { createPasswordService } from '../../server/auth/password.js';
import { createSessionMiddleware } from '../../server/auth/session.js';
import { AppError } from '../../server/errors.js';
import { UsernameConflictError } from '../../server/repositories/errors.js';
import { createAuthRouter } from '../../server/routes/auth.js';
import {
  LOGIN_WINDOW_MS,
  REGISTRATION_WINDOW_MS,
  createAuthThrottle,
} from '../../server/security/auth-throttle.js';
import { createAuthService } from '../../server/services/auth-service.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_ORIGIN = 'http://localhost:3000';
const SESSION_SECRET = 'test-session-secret-that-is-at-least-32-bytes';
const VALID_PASSWORD = 'correct horse battery';
const WRONG_PASSWORD = 'wrong password value';
const DUMMY_PASSWORD = 'dummy password value';

class FlakyDestroyMemoryStore extends session.MemoryStore {
  failDestroy = false;

  destroy(sid, callback) {
    if (this.failDestroy) {
      callback(new Error('sessionId=sid-secret cookie=app_session hash=store-secret'));
      return;
    }
    super.destroy(sid, callback);
  }
}

function createLogger() {
  const entries = [];
  return {
    entries,
    error(context, message) {
      entries.push({ context, message });
    },
  };
}

function createFastPasswordService() {
  const calls = { hash: [], verify: [] };

  function encode(password) {
    return `test-hash:${Buffer.from(password, 'utf8').toString('base64url')}`;
  }

  return {
    calls,
    service: Object.freeze({
      async hash(password) {
        calls.hash.push(password);
        return encode(password);
      },
      async verify(hash, password) {
        calls.verify.push({ hash, password });
        return hash === encode(password);
      },
    }),
  };
}

function createMemoryUserRepository() {
  const usersByUsername = new Map();
  const usersById = new Map();
  let nextId = 1;
  const calls = { create: [], findCredentials: [], findPublic: [] };
  const failures = { findCredentials: null, findPublic: null };

  const repository = Object.freeze({
    async create(value) {
      calls.create.push({ ...value });
      if (usersByUsername.has(value.username)) {
        throw new UsernameConflictError();
      }
      const user = {
        id: String(nextId++),
        username: value.username,
        passwordHash: value.passwordHash,
        bestScore: 1234,
      };
      usersByUsername.set(user.username, user);
      usersById.set(user.id, user);
      return { ...user };
    },
    async findCredentialsByUsername(username) {
      calls.findCredentials.push(username);
      if (failures.findCredentials) {
        throw failures.findCredentials;
      }
      const user = usersByUsername.get(username);
      return user ? { ...user } : null;
    },
    async findPublicById(id) {
      calls.findPublic.push(id);
      if (failures.findPublic) {
        throw failures.findPublic;
      }
      const user = usersById.get(String(id));
      return user ? { ...user } : null;
    },
  });

  return {
    calls,
    failures,
    repository,
    deleteByUsername(username) {
      const user = usersByUsername.get(username);
      if (user) {
        usersByUsername.delete(username);
        usersById.delete(user.id);
      }
    },
  };
}

async function buildHarness({
  realPassword = false,
  store = new FlakyDestroyMemoryStore(),
  authService,
  authThrottle = createAuthThrottle({ now: () => 0 }),
  sessionOps,
  trustProxy = 0,
  requestIdFactory,
} = {}) {
  const logger = createLogger();
  const users = createMemoryUserRepository();
  const fastPassword = createFastPasswordService();
  const passwordService = realPassword ? createPasswordService() : fastPassword.service;
  const dummyPasswordHash = await passwordService.hash(DUMMY_PASSWORD);
  const service = authService ?? createAuthService({
    userRepository: users.repository,
    passwordService,
    dummyPasswordHash,
  });
  const router = createAuthRouter({
    authService: service,
    authThrottle,
    ...(sessionOps ? { sessionOps } : {}),
  });
  const config = Object.freeze({
    nodeEnv: 'test',
    sessionSecret: SESSION_SECRET,
    publicOrigin: PUBLIC_ORIGIN,
    staticRoot: path.resolve(PROJECT_ROOT, 'client'),
    trustProxy,
  });
  const app = createApp({
    config,
    sessionMiddleware: createSessionMiddleware({ store, config }),
    routers: [{ path: '/api/auth', router }],
    logger,
    requestIdFactory,
  });

  return {
    app,
    authService: service,
    authThrottle,
    fastPassword,
    logger,
    passwordService,
    store,
    users,
  };
}

function protectedPost(client, pathname, body, headers = {}) {
  let pending = client
    .post(pathname)
    .set('Content-Type', 'application/json')
    .set('X-Docker-Snake-Request', '1')
    .set('Origin', PUBLIC_ORIGIN);

  for (const [name, value] of Object.entries(headers)) {
    pending = pending.set(name, value);
  }
  return pending.send(body);
}

function cookiePair(response) {
  return response.headers['set-cookie'][0].split(';', 1)[0];
}

function assertError(response, status, code, message) {
  assert.equal(response.status, status);
  assert.equal(response.body.error.code, code);
  assert.equal(response.body.error.message, message);
  assert.ok(response.body.error.requestId);
}

describe('认证 HTTP API', () => {
  test('真实 Argon2 主链：注册自动登录、Cookie、me、重复注册、退出和重新登录', async () => {
    const { app } = await buildHarness({ realPassword: true });
    const agent = request.agent(app);

    const registered = await protectedPost(agent, '/api/auth/register', {
      username: '  ALICE_1 ',
      password: '空 格😀correct-password',
    });

    assert.equal(registered.status, 201);
    assert.deepEqual(registered.body, { data: { user: { id: '1', username: 'alice_1' } } });
    assert.equal('passwordHash' in registered.body.data.user, false);
    assert.equal('bestScore' in registered.body.data.user, false);
    const cookie = registered.headers['set-cookie'][0];
    assert.match(cookie, /^app_session=/u);
    assert.match(cookie, /; Path=\//u);
    assert.match(cookie, /; HttpOnly/u);
    assert.match(cookie, /; SameSite=Lax/u);
    assert.doesNotMatch(cookie, /; Secure/u);
    const expires = /Expires=([^;]+)/u.exec(cookie)?.[1];
    assert.ok(Date.parse(expires) - Date.now() > (7 * 24 * 60 * 60 * 1000) - 10_000);

    const me = await agent.get('/api/auth/me');
    assert.deepEqual(me.body, {
      data: { authenticated: true, user: { id: '1', username: 'alice_1' } },
    });

    const duplicate = await protectedPost(agent, '/api/auth/register', {
      username: 'alice_1',
      password: 'another valid password',
    });
    assertError(duplicate, 409, 'USERNAME_TAKEN', '用户名已被占用');

    const loggedOut = await protectedPost(agent, '/api/auth/logout', {});
    assert.equal(loggedOut.status, 204);
    assert.equal(loggedOut.text, '');
    assert.match(loggedOut.headers['set-cookie'][0], /^app_session=;/u);
    assert.match(loggedOut.headers['set-cookie'][0], /Expires=Thu, 01 Jan 1970/u);

    const oldCookieMe = await request(app)
      .get('/api/auth/me')
      .set('Cookie', cookiePair(registered));
    assert.deepEqual(oldCookieMe.body, { data: { authenticated: false, user: null } });

    const guestLogout = await protectedPost(request(app), '/api/auth/logout', {});
    assertError(guestLogout, 401, 'AUTH_REQUIRED', '请先登录');

    const loggedIn = await protectedPost(agent, '/api/auth/login', {
      username: 'ALICE_1',
      password: '空 格😀correct-password',
    });
    assert.equal(loggedIn.status, 200);
    assert.deepEqual(loggedIn.body, { data: { user: { id: '1', username: 'alice_1' } } });
  });

  test('login regenerate 后旧 Session 实际访问 me 变游客', async () => {
    const { app } = await buildHarness();
    const agent = request.agent(app);
    const registered = await protectedPost(agent, '/api/auth/register', {
      username: 'alice',
      password: VALID_PASSWORD,
    });
    const oldCookie = cookiePair(registered);

    const loggedIn = await protectedPost(agent, '/api/auth/login', {
      username: 'alice',
      password: VALID_PASSWORD,
    });
    assert.equal(loggedIn.status, 200);

    const oldSession = await request(app).get('/api/auth/me').set('Cookie', oldCookie);
    const currentSession = await agent.get('/api/auth/me');
    assert.deepEqual(oldSession.body, { data: { authenticated: false, user: null } });
    assert.equal(oldSession.headers['set-cookie'], undefined);
    assert.equal(currentSession.body.data.authenticated, true);
  });

  test('游客 me 不创建 Cookie；已删除用户销毁陈旧 Session 并清 Cookie', async () => {
    const { app, users } = await buildHarness();
    const guest = await request(app).get('/api/auth/me');
    assert.deepEqual(guest.body, { data: { authenticated: false, user: null } });
    assert.equal(guest.headers['set-cookie'], undefined);

    const agent = request.agent(app);
    const registered = await protectedPost(agent, '/api/auth/register', {
      username: 'alice',
      password: VALID_PASSWORD,
    });
    const staleCookie = cookiePair(registered);
    users.deleteByUsername('alice');

    const stale = await agent.get('/api/auth/me');
    assert.equal(stale.status, 200);
    assert.deepEqual(stale.body, { data: { authenticated: false, user: null } });
    assert.match(stale.headers['set-cookie'][0], /^app_session=;/u);

    const oldCookieAfterDestroy = await request(app).get('/api/auth/me').set('Cookie', staleCookie);
    assert.deepEqual(oldCookieAfterDestroy.body, { data: { authenticated: false, user: null } });
  });

  test('陈旧 Session 销毁失败返回 500 但仍清 Cookie，仓储失败不伪装游客', async () => {
    const store = new FlakyDestroyMemoryStore();
    const { app, logger, users } = await buildHarness({ store });
    const agent = request.agent(app);
    await protectedPost(agent, '/api/auth/register', {
      username: 'alice',
      password: VALID_PASSWORD,
    });
    users.deleteByUsername('alice');
    store.failDestroy = true;

    const destroyFailed = await agent.get('/api/auth/me');
    assertError(destroyFailed, 500, 'INTERNAL_ERROR', '服务器内部错误');
    assert.match(destroyFailed.headers['set-cookie'][0], /^app_session=;/u);
    assert.doesNotMatch(destroyFailed.text, /sid-secret|app_session|store-secret/iu);
    assert.doesNotMatch(inspect(logger.entries), /sid-secret|app_session|store-secret/iu);

    const another = await buildHarness();
    const anotherAgent = request.agent(another.app);
    await protectedPost(anotherAgent, '/api/auth/register', {
      username: 'bob',
      password: VALID_PASSWORD,
    });
    another.users.failures.findPublic = new Error('database password=private');
    const repositoryFailed = await anotherAgent.get('/api/auth/me');
    assertError(repositoryFailed, 500, 'INTERNAL_ERROR', '服务器内部错误');
    assert.equal(repositoryFailed.headers['set-cookie'], undefined);
  });

  test('未知用户与错误密码返回完全同形的统一凭据错误', async () => {
    const { app } = await buildHarness({ requestIdFactory: () => 'same-request-id' });
    await protectedPost(request(app), '/api/auth/register', {
      username: 'alice',
      password: VALID_PASSWORD,
    });

    const unknown = await protectedPost(request(app), '/api/auth/login', {
      username: 'missing_user',
      password: WRONG_PASSWORD,
    });
    const wrong = await protectedPost(request(app), '/api/auth/login', {
      username: 'alice',
      password: WRONG_PASSWORD,
    });

    assertError(unknown, 401, 'INVALID_CREDENTIALS', '用户名或密码错误');
    assert.deepEqual(wrong.body, unknown.body);
    assert.doesNotMatch(unknown.text, /missing_user|hash|password/iu);
    assert.doesNotMatch(wrong.text, /alice|hash|password/iu);
  });

  test('注册 IP 第 6 次阻止，400/409 都消费且被阻止时不调用 hash/repo', async () => {
    let currentTime = 0;
    const authThrottle = createAuthThrottle({ now: () => currentTime });
    const { app, fastPassword, users } = await buildHarness({ authThrottle });
    const attempts = [
      [{ bad: true }, 400],
      [{ username: 'alice', password: VALID_PASSWORD }, 201],
      [{ username: 'alice', password: VALID_PASSWORD }, 409],
      [{ username: 'ab', password: VALID_PASSWORD }, 400],
      [{ username: 'alice', password: VALID_PASSWORD }, 409],
    ];
    for (const [body, status] of attempts) {
      assert.equal((await protectedPost(request(app), '/api/auth/register', body)).status, status);
    }
    const callsBeforeBlocked = {
      hash: fastPassword.calls.hash.length,
      create: users.calls.create.length,
    };
    currentTime = REGISTRATION_WINDOW_MS - 1_001;

    const blocked = await protectedPost(request(app), '/api/auth/register', {
      username: 'bob',
      password: VALID_PASSWORD,
    });

    assertError(blocked, 429, 'RATE_LIMITED', '请求过于频繁，请稍后再试');
    assert.equal(blocked.headers['retry-after'], '2');
    assert.equal(fastPassword.calls.hash.length, callsBeforeBlocked.hash);
    assert.equal(users.calls.create.length, callsBeforeBlocked.create);
  });

  test('同一规范化用户名第 6 次登录阻止，且在 repo/verify 前短路', async () => {
    let currentTime = 0;
    const authThrottle = createAuthThrottle({ now: () => currentTime });
    const { app, fastPassword, users } = await buildHarness({ authThrottle });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const failed = await protectedPost(request(app), '/api/auth/login', {
        username: '  MISSING_USER ',
        password: WRONG_PASSWORD,
      });
      assert.equal(failed.status, 401);
    }
    const before = {
      find: users.calls.findCredentials.length,
      verify: fastPassword.calls.verify.length,
    };
    currentTime = LOGIN_WINDOW_MS - 1;

    const blocked = await protectedPost(request(app), '/api/auth/login', {
      username: 'missing_user',
      password: WRONG_PASSWORD,
    });

    assert.equal(blocked.status, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    assert.equal(users.calls.findCredentials.length, before.find);
    assert.equal(fastPassword.calls.verify.length, before.verify);
  });

  test('并发登录在异步凭据验证前原子预留配额，同用户名最多 5 个进入 service', async () => {
    let serviceCalls = 0;
    let releaseService;
    let reachedFive;
    const serviceGate = new Promise((resolve) => {
      releaseService = resolve;
    });
    const fiveCallsReached = new Promise((resolve) => {
      reachedFive = resolve;
    });
    const gatedService = {
      async login() {
        serviceCalls += 1;
        if (serviceCalls === 5) {
          reachedFive();
        }
        await serviceGate;
        throw new AppError({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: '用户名或密码错误',
        });
      },
    };
    const { app } = await buildHarness({ authService: gatedService });
    const pending = Array.from({ length: 20 }, () => protectedPost(request(app), '/api/auth/login', {
      username: 'alice',
      password: WRONG_PASSWORD,
    }));
    const responsesPromise = Promise.all(pending);

    await fiveCallsReached;
    await new Promise((resolve) => setImmediate(resolve));
    releaseService();
    const responses = await responsesPromise;

    assert.equal(serviceCalls, 5);
    assert.equal(responses.filter(({ status }) => status === 401).length, 5);
    assert.equal(responses.filter(({ status }) => status === 429).length, 15);
  });

  test('同一 IP 第 11 次登录阻止，不同合法用户名键彼此隔离', async () => {
    const { app, fastPassword, users } = await buildHarness();

    for (let attempt = 0; attempt < 10; attempt += 1) {
      const failed = await protectedPost(request(app), '/api/auth/login', {
        username: `missing_${attempt}`,
        password: WRONG_PASSWORD,
      });
      assert.equal(failed.status, 401);
    }
    const before = {
      find: users.calls.findCredentials.length,
      verify: fastPassword.calls.verify.length,
    };

    const blocked = await protectedPost(request(app), '/api/auth/login', {
      username: 'missing_10',
      password: WRONG_PASSWORD,
    });
    assert.equal(blocked.status, 429);
    assert.equal(users.calls.findCredentials.length, before.find);
    assert.equal(fastPassword.calls.verify.length, before.verify);
  });

  test('成功登录清用户名失败但不清 IP 失败', async () => {
    const { app, fastPassword, users } = await buildHarness();
    await protectedPost(request(app), '/api/auth/register', {
      username: 'alice',
      password: VALID_PASSWORD,
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await protectedPost(request(app), '/api/auth/login', {
        username: 'alice', password: WRONG_PASSWORD,
      })).status, 401);
    }
    assert.equal((await protectedPost(request(app), '/api/auth/login', {
      username: 'alice', password: VALID_PASSWORD,
    })).status, 200);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await protectedPost(request(app), '/api/auth/login', {
        username: 'alice', password: WRONG_PASSWORD,
      })).status, 401);
    }
    assert.equal((await protectedPost(request(app), '/api/auth/login', {
      username: 'bob', password: WRONG_PASSWORD,
    })).status, 401);
    const before = {
      find: users.calls.findCredentials.length,
      verify: fastPassword.calls.verify.length,
    };

    const ipBlocked = await protectedPost(request(app), '/api/auth/login', {
      username: 'charlie', password: WRONG_PASSWORD,
    });
    assert.equal(ipBlocked.status, 429);
    assert.equal(users.calls.findCredentials.length, before.find);
    assert.equal(fastPassword.calls.verify.length, before.verify);
  });

  test('业务 5xx 不计失败；Session 建立失败既不计失败也不提前清用户名桶', async () => {
    let internalFailure = true;
    let serviceCalls = 0;
    const customService = {
      async login() {
        serviceCalls += 1;
        if (internalFailure) {
          throw new Error('password=service-secret hash=private cookie=sid-secret');
        }
        throw new AppError({
          status: 401,
          code: 'INVALID_CREDENTIALS',
          message: '用户名或密码错误',
        });
      },
    };
    const serverErrors = await buildHarness({ authService: customService });
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const response = await protectedPost(request(serverErrors.app), '/api/auth/login', {
        username: 'alice', password: WRONG_PASSWORD,
      });
      assert.equal(response.status, 500);
      assert.doesNotMatch(response.text, /service-secret|private|sid-secret/u);
    }
    internalFailure = false;
    assert.equal((await protectedPost(request(serverErrors.app), '/api/auth/login', {
      username: 'alice', password: WRONG_PASSWORD,
    })).status, 401);
    assert.equal(serviceCalls, 7);

    const store = new FlakyDestroyMemoryStore();
    const sessionFailure = await buildHarness({ store });
    await protectedPost(request(sessionFailure.app), '/api/auth/register', {
      username: 'alice', password: VALID_PASSWORD,
    });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      assert.equal((await protectedPost(request(sessionFailure.app), '/api/auth/login', {
        username: 'alice', password: WRONG_PASSWORD,
      })).status, 401);
    }
    store.failDestroy = true;
    assert.equal((await protectedPost(request(sessionFailure.app), '/api/auth/login', {
      username: 'alice', password: VALID_PASSWORD,
    })).status, 500);
    assert.equal((await protectedPost(request(sessionFailure.app), '/api/auth/login', {
      username: 'alice', password: WRONG_PASSWORD,
    })).status, 401);
    assert.equal((await protectedPost(request(sessionFailure.app), '/api/auth/login', {
      username: 'alice', password: WRONG_PASSWORD,
    })).status, 429);
  });

  test('trust proxy 决定注册 IP 键，异步错误响应与日志不泄漏敏感内容', async () => {
    const rejectingService = {
      async register() {
        throw new AppError({ status: 400, code: 'INVALID_INPUT', message: '输入内容不符合要求' });
      },
      async login() {
        throw new Error('password=api-secret hash=hash-secret cookie=app_session SID=sid-secret');
      },
    };
    const { app, logger } = await buildHarness({
      authService: rejectingService,
      trustProxy: 1,
    });

    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await protectedPost(request(app), '/api/auth/register', {}, {
        'X-Forwarded-For': '203.0.113.10',
      })).status, 400);
    }
    assert.equal((await protectedPost(request(app), '/api/auth/register', {}, {
      'X-Forwarded-For': '203.0.113.10',
    })).status, 429);
    assert.equal((await protectedPost(request(app), '/api/auth/register', {}, {
      'X-Forwarded-For': '203.0.113.11',
    })).status, 400);

    const asyncError = await protectedPost(request(app), '/api/auth/login', {
      username: 'alice', password: 'api-secret-value',
    }, { 'X-Forwarded-For': '203.0.113.12' });
    assertError(asyncError, 500, 'INTERNAL_ERROR', '服务器内部错误');
    assert.doesNotMatch(asyncError.text, /api-secret|hash-secret|app_session|sid-secret/iu);
    assert.doesNotMatch(inspect(logger.entries), /api-secret|hash-secret|app_session|sid-secret/iu);
  });
});
