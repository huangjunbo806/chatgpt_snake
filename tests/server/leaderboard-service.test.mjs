import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppError } from '../../server/errors.js';
import { createLeaderboardService } from '../../server/services/leaderboard-service.js';

function createDependencies(overrides = {}) {
  const calls = {
    raise: [],
    top: [],
    standing: [],
  };
  const repository = {
    async raiseBestScore(value) {
      calls.raise.push(value);
      return false;
    },
    async findTop(options) {
      calls.top.push(options);
      return [Object.freeze({
        rank: 1,
        username: 'winner',
        bestScore: 300,
        bestScoreAt: '2026-07-14T00:00:00.000Z',
      })];
    },
    async findUserStandingById(userId) {
      calls.standing.push(userId);
      return {
        rank: 2,
        username: 'alice',
        bestScore: 200,
        bestScoreAt: '2026-07-14T00:01:00.000Z',
      };
    },
    ...overrides,
  };

  return {
    calls,
    service: createLeaderboardService({ repository }),
  };
}

function assertAuthRequired(error) {
  assert.equal(error instanceof AppError, true);
  assert.deepEqual({ status: error.status, code: error.code, message: error.message }, {
    status: 401,
    code: 'AUTH_REQUIRED',
    message: '请先登录',
  });
  return true;
}

describe('排行榜服务', () => {
  test('返回只包含 submit/read 的冻结 API', () => {
    const { service } = createDependencies();

    assert.equal(Object.isFrozen(service), true);
    assert.deepEqual(Object.keys(service).sort(), ['read', 'submit']);
  });

  test('非法分数在仓储调用前被拒绝', async () => {
    const { calls, service } = createDependencies();

    await assert.rejects(
      service.submit('7', { score: '100', durationMs: 700 }),
      (error) => error instanceof AppError && error.code === 'INVALID_SCORE',
    );

    assert.deepEqual(calls.raise, []);
    assert.deepEqual(calls.standing, []);
  });

  test('submit 传入规范分数，并以查到的真实最终分数和名次为准', async (t) => {
    for (const updated of [true, false]) {
      await t.test(`updated=${updated}`, async () => {
        const calls = [];
        const { service } = createDependencies({
          async raiseBestScore(value) {
            calls.push(['raise', value]);
            return updated;
          },
          async findUserStandingById(userId) {
            calls.push(['standing', userId]);
            return {
              rank: 4,
              username: 'alice',
              bestScore: 250,
              bestScoreAt: '2026-07-14T00:00:00.000Z',
            };
          },
        });

        const result = await service.submit('7', { score: 200, durationMs: 1_400 });

        assert.deepEqual(calls, [
          ['raise', { userId: '7', score: 200 }],
          ['standing', '7'],
        ]);
        assert.deepEqual(result, { updated, bestScore: 250, rank: 4 });
        assert.equal(Object.isFrozen(result), true);
      });
    }
  });

  test('submit 查询最终排名时用户已不存在则要求重新登录', async () => {
    const { service } = createDependencies({
      async raiseBestScore() {
        return true;
      },
      async findUserStandingById() {
        return null;
      },
    });

    await assert.rejects(
      service.submit('deleted', { score: 10, durationMs: 70 }),
      assertAuthRequired,
    );
  });

  test('游客只读取前百名，返回冻结 entries 与 null me', async () => {
    const { calls, service } = createDependencies();

    const result = await service.read();

    assert.deepEqual(calls.top, [undefined]);
    assert.deepEqual(calls.standing, []);
    assert.equal(result.me, null);
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.entries), true);
    assert.equal(Object.isFrozen(result.entries[0]), true);
  });

  test('登录用户即使零分也返回完整冻结 me', async () => {
    const { service } = createDependencies({
      async findTop() {
        return [];
      },
      async findUserStandingById(userId) {
        assert.equal(userId, 'zero-user');
        return {
          rank: null,
          username: 'new_player',
          bestScore: 0,
          bestScoreAt: null,
        };
      },
    });

    const result = await service.read('zero-user');

    assert.deepEqual(result, {
      entries: [],
      me: {
        rank: null,
        username: 'new_player',
        bestScore: 0,
        bestScoreAt: null,
      },
    });
    assert.equal(Object.isFrozen(result), true);
    assert.equal(Object.isFrozen(result.entries), true);
    assert.equal(Object.isFrozen(result.me), true);
  });

  test('登外用户保留大于一百的真实名次', async () => {
    const { service } = createDependencies({
      async findTop() {
        return [];
      },
      async findUserStandingById() {
        return {
          rank: 105,
          username: 'outside',
          bestScore: 10,
          bestScoreAt: '2026-07-14T00:00:00.000Z',
        };
      },
    });

    assert.equal((await service.read('105')).me.rank, 105);
  });

  test('登录 session 指向不存在用户时返回 401', async () => {
    const { service } = createDependencies({
      async findTop() {
        return [];
      },
      async findUserStandingById() {
        return null;
      },
    });

    await assert.rejects(service.read('deleted'), assertAuthRequired);
  });
});
