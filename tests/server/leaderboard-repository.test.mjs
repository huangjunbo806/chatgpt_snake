import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLeaderboardRepository } from '../../server/repositories/leaderboard-repository.js';

function createRecordingPool(responses = []) {
  const pending = [...responses];
  const calls = [];

  return {
    calls,
    async query(text, values) {
      calls.push({ text, values });
      return pending.shift() ?? { rows: [], rowCount: 0 };
    },
  };
}

function normalizeSql(text) {
  return text.replace(/\s+/gu, ' ').trim();
}

function readPlaceholder(sql, pattern, message) {
  const match = sql.match(pattern);
  assert.ok(match, message);
  return Number(match[1]);
}

function assertRankingWindow(sql) {
  assert.match(
    sql,
    /ROW_NUMBER\s*\(\s*\)\s+OVER\s*\(\s*ORDER\s+BY\s+(?:[a-z_]\w*\.)?best_score\s+DESC\s*,\s*(?:[a-z_]\w*\.)?best_score_at\s+ASC\s*,\s*(?:[a-z_]\w*\.)?id\s+ASC\s*\)/iu,
  );
}

function assertOuterRankingOrder(sql) {
  const rankingOrders = [...sql.matchAll(
    /ORDER\s+BY\s+(?:[a-z_]\w*\.)?best_score\s+DESC\s*,\s*(?:[a-z_]\w*\.)?best_score_at\s+ASC\s*,\s*(?:[a-z_]\w*\.)?id\s+ASC/giu,
  )];
  assert.ok(rankingOrders.length >= 2, '窗口编号后必须使用相同三键顺序输出 top');
}

describe('createLeaderboardRepository', () => {
  test('返回冻结 API 并拒绝缺失的 pool', () => {
    const repository = createLeaderboardRepository({ pool: createRecordingPool() });

    assert.equal(Object.isFrozen(repository), true);
    assert.deepEqual(Object.keys(repository).sort(), [
      'findTop',
      'findUserStandingById',
      'raiseBestScore',
    ]);
    assert.throws(
      () => createLeaderboardRepository(),
      /createLeaderboardRepository.*pool/u,
    );
  });

  test('raiseBestScore 以单条条件 UPDATE 参数化提分并把 rowCount 映射为布尔值', async () => {
    const maliciousUserId = "42'; DROP TABLE public.users; --";
    const score = 200;
    const pool = createRecordingPool([
      { rows: [], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]);
    const repository = createLeaderboardRepository({ pool });

    assert.equal(
      await repository.raiseBestScore({ userId: maliciousUserId, score }),
      true,
    );
    assert.equal(pool.calls.length, 1);
    assert.equal(
      await repository.raiseBestScore({ userId: maliciousUserId, score }),
      false,
    );
    assert.equal(pool.calls.length, 2);

    for (const call of pool.calls) {
      const sql = normalizeSql(call.text);
      assert.match(sql, /^UPDATE\s+public\.users\b/iu);
      assert.match(sql, /\bSET\s+best_score\s*=\s*\$\d+/iu);
      assert.match(sql, /\bbest_score_at\s*=/iu);
      assert.match(sql, /\bWHERE\b.*\b(?:[a-z_]\w*\.)?id\s*=\s*\$\d+/iu);
      assert.match(sql, /\bbest_score\s*<\s*\$\d+/iu);
      assert.equal(sql.includes(maliciousUserId), false);
      assert.equal(Array.isArray(call.values), true);
      assert.equal(
        call.values.filter((value) => value === maliciousUserId).length,
        1,
      );

      const scorePlaceholder = readPlaceholder(
        sql,
        /\bSET\s+best_score\s*=\s*\$(\d+)/iu,
        'UPDATE 应参数化 best_score',
      );
      const userIdPlaceholder = readPlaceholder(
        sql,
        /\bWHERE\b.*\b(?:[a-z_]\w*\.)?id\s*=\s*\$(\d+)/iu,
        'UPDATE 应参数化用户 id',
      );
      const comparisonPlaceholder = readPlaceholder(
        sql,
        /\bbest_score\s*<\s*\$(\d+)/iu,
        'UPDATE 应只接受严格更高的分数',
      );

      assert.equal(call.values[scorePlaceholder - 1], score);
      assert.equal(call.values[userIdPlaceholder - 1], maliciousUserId);
      assert.equal(call.values[comparisonPlaceholder - 1], score);
    }
  });

  test('findTop 查询全部正分后按三键编号并返回冻结的公开映射', async () => {
    const firstReachedAt = new Date('2026-07-14T02:03:04.567Z');
    const pool = createRecordingPool([{
      rows: [
        {
          id: '9007199254740993',
          username: 'alpha_snake',
          password_hash: 'must-not-leak',
          best_score: '3960',
          best_score_at: firstReachedAt,
          rank: '1',
        },
        {
          id: 8n,
          username: 'beta_snake',
          password_hash: 'also-must-not-leak',
          best_score: 300,
          best_score_at: '2026-07-14T03:04:05.000Z',
          rank: 2n,
        },
      ],
      rowCount: 2,
    }]);
    const repository = createLeaderboardRepository({ pool });

    const entries = await repository.findTop({ limit: 2 });

    assert.deepEqual(entries, [
      {
        rank: 1,
        username: 'alpha_snake',
        bestScore: 3960,
        bestScoreAt: '2026-07-14T02:03:04.567Z',
      },
      {
        rank: 2,
        username: 'beta_snake',
        bestScore: 300,
        bestScoreAt: '2026-07-14T03:04:05.000Z',
      },
    ]);
    assert.equal(Object.isFrozen(entries), true);
    for (const entry of entries) {
      assert.equal(Object.isFrozen(entry), true);
      assert.equal('id' in entry, false);
      assert.equal('passwordHash' in entry, false);
      assert.equal('password_hash' in entry, false);
    }

    assert.equal(pool.calls.length, 1);
    const call = pool.calls[0];
    const sql = normalizeSql(call.text);
    assertRankingWindow(sql);
    assertOuterRankingOrder(sql);
    assert.match(sql, /\bWHERE\s+(?:[a-z_]\w*\.)?best_score\s*>\s*0\b/iu);
    assert.match(sql, /\bLIMIT\s+\$1\b/iu);
    assert.doesNotMatch(sql, /password_hash/iu);
    assert.deepEqual(call.values, [2]);
  });

  test('findTop 默认限制 100 条、接受 1 与 100 并拒绝范围外或非整数 limit', async () => {
    const pool = createRecordingPool();
    const repository = createLeaderboardRepository({ pool });

    await repository.findTop();
    await repository.findTop({ limit: 1 });
    await repository.findTop({ limit: 100 });

    assert.deepEqual(
      pool.calls.map(({ values }) => values),
      [[100], [1], [100]],
    );

    for (const limit of [0, 101, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '10']) {
      await assert.rejects(
        () => repository.findTop({ limit }),
        Error,
      );
    }
    assert.equal(pool.calls.length, 3);
  });

  test('findUserStandingById 在全部正分窗口之后按 id LEFT JOIN 并保留榜外名次', async () => {
    const maliciousUserId = "105' OR TRUE --";
    const pool = createRecordingPool([
      {
        rows: [{
          id: '105',
          username: 'outside_top',
          password_hash: 'must-not-leak',
          best_score: '100',
          best_score_at: new Date('2026-07-14T05:06:07.890Z'),
          rank: '105',
        }],
        rowCount: 1,
      },
      {
        rows: [{
          id: '106',
          username: 'zero_score',
          password_hash: 'must-not-leak',
          best_score: 0,
          best_score_at: null,
          rank: null,
        }],
        rowCount: 1,
      },
      { rows: [], rowCount: 0 },
    ]);
    const repository = createLeaderboardRepository({ pool });

    const standing = await repository.findUserStandingById(maliciousUserId);
    assert.deepEqual(standing, {
      rank: 105,
      username: 'outside_top',
      bestScore: 100,
      bestScoreAt: '2026-07-14T05:06:07.890Z',
    });
    assert.equal(Object.isFrozen(standing), true);
    assert.equal('id' in standing, false);
    assert.equal('passwordHash' in standing, false);
    assert.equal('password_hash' in standing, false);

    const zeroScoreStanding = await repository.findUserStandingById('106');
    assert.deepEqual(zeroScoreStanding, {
      rank: null,
      username: 'zero_score',
      bestScore: 0,
      bestScoreAt: null,
    });
    assert.equal(Object.isFrozen(zeroScoreStanding), true);
    assert.equal(await repository.findUserStandingById('999999'), null);

    const call = pool.calls[0];
    const sql = normalizeSql(call.text);
    assertRankingWindow(sql);
    const positiveFilterIndex = sql.search(
      /\bWHERE\s+(?:[a-z_]\w*\.)?best_score\s*>\s*0\b/iu,
    );
    const leftJoinIndex = sql.search(/\bLEFT\s+JOIN\b/iu);
    const userFilterIndex = sql.search(
      /\b(?:[a-z_]\w*\.)?id\s*=\s*\$1\b/iu,
    );
    assert.ok(positiveFilterIndex >= 0, '排名窗口应排除 0 分用户');
    assert.ok(leftJoinIndex >= 0, '个人排名应由用户记录 LEFT JOIN 全局排名窗口');
    assert.ok(userFilterIndex > positiveFilterIndex, '完整正分排名应先于用户 id 过滤');
    assert.doesNotMatch(sql, /password_hash/iu);
    assert.equal(sql.includes(maliciousUserId), false);
    assert.deepEqual(call.values, [maliciousUserId]);
  });
});
