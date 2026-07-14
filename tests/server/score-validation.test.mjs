import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { AppError } from '../../server/errors.js';
import { parseScoreSubmission } from '../../server/services/score-validation.js';

function assertInvalidScore(body) {
  assert.throws(() => parseScoreSubmission(body), (error) => {
    assert.equal(error instanceof AppError, true);
    assert.deepEqual({
      status: error.status,
      code: error.code,
      message: error.message,
    }, {
      status: 400,
      code: 'INVALID_SCORE',
      message: '成绩数据不符合要求',
    });
    assert.doesNotMatch(error.message, /999999|outcome|Infinity|NaN/u);
    return true;
  });
}

describe('分数提交校验', () => {
  test('接受零分、最小正分和理论最大值并返回冻结投影', () => {
    for (const [body, expected] of [
      [{ score: 0, durationMs: 0 }, { score: 0, durationMs: 0 }],
      [{ score: 10, durationMs: 70 }, { score: 10, durationMs: 70 }],
      [
        { score: 3960, durationMs: 86_400_000 },
        { score: 3960, durationMs: 86_400_000 },
      ],
    ]) {
      const parsed = parseScoreSubmission(body);

      assert.deepEqual(parsed, expected);
      assert.equal(Object.isFrozen(parsed), true);
      assert.notEqual(parsed, body);
    }
  });

  test('正分每十分至少需要七十毫秒，少一毫秒也拒绝', () => {
    assert.deepEqual(parseScoreSubmission({ score: 100, durationMs: 700 }), {
      score: 100,
      durationMs: 700,
    });
    assertInvalidScore({ score: 100, durationMs: 699 });
    assertInvalidScore({ score: 3960, durationMs: 27_719 });
  });

  test('只接受恰含 score 与 durationMs 自有键的普通 JSON 对象', () => {
    const inherited = Object.assign(Object.create({ inherited: true }), {
      score: 10,
      durationMs: 70,
    });

    for (const body of [
      null,
      [],
      'json',
      new Date(),
      Object.create(null),
      inherited,
      { score: 10 },
      { durationMs: 70 },
      { score: 10, durationMs: 70, outcome: 'won' },
      Object.defineProperty({ score: 10, durationMs: 70 }, Symbol('extra'), { value: true }),
    ]) {
      assertInvalidScore(body);
    }
  });

  test('拒绝负分、越界、非十倍数、浮点、字符串与非有限分数', () => {
    for (const score of [
      -10,
      3970,
      11,
      10.5,
      '10',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol('score'),
    ]) {
      assertInvalidScore({ score, durationMs: 86_400_000 });
    }
  });

  test('拒绝负时长、越界、浮点、字符串与非有限时长', () => {
    for (const durationMs of [
      -1,
      86_400_001,
      70.5,
      '70',
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Symbol('durationMs'),
    ]) {
      assertInvalidScore({ score: 10, durationMs });
    }
  });
});
