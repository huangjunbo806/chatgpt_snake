import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import request from 'supertest';

import { createApp } from '../../server/app.js';
import { AppError } from '../../server/errors.js';
import { createLeaderboardRouter } from '../../server/routes/leaderboard.js';
import { createScoresRouter } from '../../server/routes/scores.js';
import { createScoreThrottle } from '../../server/security/score-throttle.js';
import { createLeaderboardService } from '../../server/services/leaderboard-service.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_ORIGIN = 'http://localhost:3000';
const CONFIG = Object.freeze({
  nodeEnv: 'test',
  publicOrigin: PUBLIC_ORIGIN,
  staticRoot: path.resolve(PROJECT_ROOT, 'client'),
  trustProxy: 0,
});

function createLogger() {
  const entries = [];
  return {
    entries,
    error(context, message) {
      entries.push({ context, message });
    },
  };
}

function sessionFromTestHeader(req, res, next) {
  const userId = req.get('X-Test-User-Id');
  if (userId !== undefined) {
    req.session = { userId };
  }
  next();
}

function buildApp({ scoreService, scoreThrottle, leaderboardService, logger = createLogger() } = {}) {
  const routers = [];
  if (scoreService && scoreThrottle) {
    routers.push({
      path: '/api/scores',
      router: createScoresRouter({ service: scoreService, throttle: scoreThrottle }),
    });
  }
  if (leaderboardService) {
    routers.push({
      path: '/api/leaderboard',
      router: createLeaderboardRouter({ service: leaderboardService }),
    });
  }

  return createApp({
    config: CONFIG,
    sessionMiddleware: sessionFromTestHeader,
    routers,
    logger,
    requestIdFactory: () => 'score-request-id',
  });
}

function protectedPost(app, body, userId) {
  let pending = request(app)
    .post('/api/scores')
    .set('Content-Type', 'application/json')
    .set('X-Docker-Snake-Request', '1')
    .set('Origin', PUBLIC_ORIGIN);
  if (userId !== undefined) {
    pending = pending.set('X-Test-User-Id', userId);
  }
  return pending.send(body);
}

function invalidScoreError() {
  return new AppError({
    status: 400,
    code: 'INVALID_SCORE',
    message: '成绩数据不符合要求',
  });
}

describe('最高分 HTTP API', () => {
  test('未登录先返回 401，不消耗限流也不调用服务', async () => {
    const calls = { consume: [], submit: [] };
    const app = buildApp({
      scoreThrottle: {
        consumeSubmission(userId) {
          calls.consume.push(userId);
          return { blocked: false, remaining: 11, retryAfterMs: 0 };
        },
      },
      scoreService: {
        async submit(...args) {
          calls.submit.push(args);
          return { updated: true, bestScore: 10, rank: 1 };
        },
      },
    });

    const response = await protectedPost(app, { score: 10, durationMs: 70 });

    assert.equal(response.status, 401);
    assert.equal(response.body.error.code, 'AUTH_REQUIRED');
    assert.equal(response.body.error.message, '请先登录');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, { consume: [], submit: [] });
  });

  test('登录提交按 userId 消耗配额并把原始 JSON body 交给服务', async () => {
    const calls = { consume: [], submit: [] };
    const result = Object.freeze({ updated: true, bestScore: 200, rank: 3 });
    const app = buildApp({
      scoreThrottle: {
        consumeSubmission(userId) {
          calls.consume.push(userId);
          return { blocked: false, remaining: 11, retryAfterMs: 0 };
        },
      },
      scoreService: {
        async submit(...args) {
          calls.submit.push(args);
          return result;
        },
      },
    });
    const body = { score: 200, durationMs: 1_400 };

    const response = await protectedPost(app, body, '42');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: result });
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.deepEqual(calls.consume, ['42']);
    assert.deepEqual(calls.submit, [['42', body]]);
  });

  test('已认证的非法分数也消耗配额，第十三次返回 429 且不再调用服务', async () => {
    const calls = [];
    const app = buildApp({
      scoreThrottle: createScoreThrottle({ now: () => 0 }),
      scoreService: {
        async submit(userId, body) {
          calls.push({ userId, body });
          throw invalidScoreError();
        },
      },
    });

    for (let attempt = 1; attempt <= 12; attempt += 1) {
      const invalid = await protectedPost(app, { score: 'bad', durationMs: 0 }, '7');
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'INVALID_SCORE');
      assert.equal(invalid.headers['cache-control'], 'no-store');
    }

    const blocked = await protectedPost(app, { score: 'bad', durationMs: 0 }, '7');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.equal(blocked.body.error.message, '请求过于频繁，请稍后再试');
    assert.equal(blocked.headers['retry-after'], '60');
    assert.match(blocked.headers['retry-after'], /^\d+$/u);
    assert.equal(blocked.headers['cache-control'], 'no-store');
    assert.equal(calls.length, 12);
  });

  test('合法 JSON 标量进入真实分数校验并消耗配额', async () => {
    const repositoryCalls = [];
    const service = createLeaderboardService({
      repository: {
        async raiseBestScore(value) {
          repositoryCalls.push(['raise', value]);
          return false;
        },
        async findUserStandingById(userId) {
          repositoryCalls.push(['standing', userId]);
          return null;
        },
      },
    });
    const app = buildApp({
      scoreThrottle: createScoreThrottle({ now: () => 0 }),
      scoreService: service,
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      const invalid = await protectedPost(app, '"not-an-object"', 'scalar-user');
      assert.equal(invalid.status, 400);
      assert.equal(invalid.body.error.code, 'INVALID_SCORE');
      assert.equal(invalid.headers['cache-control'], 'no-store');
    }

    const blocked = await protectedPost(app, '"not-an-object"', 'scalar-user');
    assert.equal(blocked.status, 429);
    assert.equal(blocked.body.error.code, 'RATE_LIMITED');
    assert.equal(blocked.headers['retry-after'], '60');
    assert.deepEqual(repositoryCalls, []);
  });

  test('限流按用户隔离，一个用户被阻止不影响另一个用户', async () => {
    const calls = [];
    const app = buildApp({
      scoreThrottle: createScoreThrottle({ now: () => 0 }),
      scoreService: {
        async submit(userId) {
          calls.push(userId);
          return { updated: false, bestScore: 0, rank: null };
        },
      },
    });

    for (let attempt = 0; attempt < 12; attempt += 1) {
      assert.equal((await protectedPost(app, { score: 0, durationMs: 0 }, 'user-a')).status, 200);
    }
    assert.equal((await protectedPost(app, { score: 0, durationMs: 0 }, 'user-a')).status, 429);
    assert.equal((await protectedPost(app, { score: 0, durationMs: 0 }, 'user-b')).status, 200);
    assert.equal(calls.filter((userId) => userId === 'user-a').length, 12);
    assert.equal(calls.at(-1), 'user-b');
  });
});

describe('休闲排行榜 HTTP API', () => {
  test('GET 同时支持游客与登录用户，分别传 null 和 session userId', async () => {
    const calls = [];
    const entries = [{
      rank: 1,
      username: 'winner',
      bestScore: 300,
      bestScoreAt: '2026-07-14T00:00:00.000Z',
    }];
    const service = {
      async read(userId) {
        calls.push(userId);
        return {
          entries,
          me: userId === null ? null : {
            rank: null,
            username: 'new_player',
            bestScore: 0,
            bestScoreAt: null,
          },
        };
      },
    };
    const app = buildApp({ leaderboardService: service });

    const guest = await request(app).get('/api/leaderboard');
    const loggedIn = await request(app)
      .get('/api/leaderboard')
      .set('X-Test-User-Id', '42');

    assert.equal(guest.status, 200);
    assert.deepEqual(guest.body, { data: { entries, me: null } });
    assert.equal(guest.headers['cache-control'], 'no-store');
    assert.equal(loggedIn.status, 200);
    assert.equal(loggedIn.body.data.me.username, 'new_player');
    assert.equal(loggedIn.headers['cache-control'], 'no-store');
    assert.deepEqual(calls, [null, '42']);
  });

  test('分数与排行服务的异步异常都走统一脱敏错误处理', async (t) => {
    for (const route of ['scores', 'leaderboard']) {
      await t.test(route, async () => {
        const logger = createLogger();
        const secretError = new Error('body-score-secret cookie=app_session sessionId=sid-secret');
        const app = route === 'scores'
          ? buildApp({
            logger,
            scoreThrottle: {
              consumeSubmission() {
                return { blocked: false, remaining: 11, retryAfterMs: 0 };
              },
            },
            scoreService: {
              async submit() {
                throw secretError;
              },
            },
          })
          : buildApp({
            logger,
            leaderboardService: {
              async read() {
                throw secretError;
              },
            },
          });

        const response = route === 'scores'
          ? await protectedPost(app, { score: 123_456_789, secret: 'body-secret' }, '7')
            .set('Cookie', 'app_session=sid-cookie-secret')
          : await request(app)
            .get('/api/leaderboard?token=query-secret')
            .set('X-Test-User-Id', '7')
            .set('Cookie', 'app_session=sid-cookie-secret');

        assert.equal(response.status, 500);
        assert.deepEqual(response.body, {
          error: {
            code: 'INTERNAL_ERROR',
            message: '服务器内部错误',
            requestId: 'score-request-id',
          },
        });
        assert.equal(response.headers['cache-control'], 'no-store');
        assert.doesNotMatch(
          `${response.text} ${inspect(logger.entries)}`,
          /123456789|body-secret|query-secret|sid-secret|sid-cookie-secret|app_session/iu,
        );
      });
    }
  });
});
