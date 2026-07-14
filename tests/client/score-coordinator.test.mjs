import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ScoreOwnershipError,
  createScoreCoordinator,
} from '../../client/scripts/score-coordinator.js';

function createHarness(initialSnapshot = { status: 'guest', user: null }) {
  let snapshot = initialSnapshot;
  let guestBest = 80;
  const submitted = [];
  const displayed = [];
  let refreshes = 0;
  const coordinator = createScoreCoordinator({
    api: {
      async submitScore(body) {
        submitted.push(body);
        return { updated: true, bestScore: body.score, rank: 1 };
      },
    },
    guestScoreStore: {
      getBestScore: () => guestBest,
      recordScore(score) {
        guestBest = Math.max(guestBest, Number.isInteger(score) ? score : 0);
        return guestBest;
      },
    },
    getAuthSnapshot: () => snapshot,
    onBestScore: (score) => displayed.push(score),
    onScoreSubmitted: () => { refreshes += 1; },
  });

  return {
    coordinator,
    displayed,
    submitted,
    refreshes: () => refreshes,
    setSnapshot(next) { snapshot = next; },
  };
}

describe('成绩归属协调器', () => {
  test('游客局中登录只写游客最高分，不上传也不覆盖账户显示', async () => {
    const harness = createHarness();
    const owner = harness.coordinator.beginRound();
    harness.setSnapshot({ status: 'authenticated', user: { id: '1', username: 'alice' } });

    await harness.coordinator.finishRound({ score: 100, durationMs: 700, outcome: 'wall' }, owner);

    assert.deepEqual(owner, { kind: 'guest' });
    assert.equal(Object.isFrozen(owner), true);
    assert.deepEqual(harness.submitted, []);
    assert.deepEqual(harness.displayed, []);
  });

  test('A 的游戏在退出或切换 B 后不能提交，A 再登录可用原 token 重试', async () => {
    const harness = createHarness({ status: 'authenticated', user: { id: '1', username: 'alice' } });
    const owner = harness.coordinator.beginRound();
    const result = { score: 120, durationMs: 840, outcome: 'wall' };

    harness.setSnapshot({ status: 'guest', user: null });
    await assert.rejects(
      harness.coordinator.finishRound(result, owner),
      ScoreOwnershipError,
    );

    harness.setSnapshot({ status: 'authenticated', user: { id: '2', username: 'bob' } });
    await assert.rejects(
      harness.coordinator.finishRound(result, owner),
      ScoreOwnershipError,
    );
    assert.deepEqual(harness.submitted, []);

    harness.setSnapshot({ status: 'authenticated', user: { id: '1', username: 'alice' } });
    await harness.coordinator.finishRound(result, owner);
    assert.deepEqual(harness.submitted, [{ score: 120, durationMs: 840 }]);
    assert.deepEqual(harness.displayed, [120]);
    assert.equal(harness.refreshes(), 1);
  });

  test('A 的请求未决时切换 B，响应不会覆盖 B 的最高分', async () => {
    let finishRequest;
    let snapshot = { status: 'authenticated', user: { id: '1', username: 'alice' } };
    const displayed = [];
    const coordinator = createScoreCoordinator({
      api: {
        submitScore() {
          return new Promise((resolve) => { finishRequest = resolve; });
        },
      },
      guestScoreStore: { getBestScore: () => 0, recordScore: () => 0 },
      getAuthSnapshot: () => snapshot,
      onBestScore: (score) => displayed.push(score),
    });
    const owner = coordinator.beginRound();
    const pending = coordinator.finishRound({ score: 200, durationMs: 1400 }, owner);

    snapshot = { status: 'authenticated', user: { id: '2', username: 'bob' } };
    finishRequest({ updated: true, bestScore: 200, rank: 1 });
    await pending;

    assert.deepEqual(displayed, []);
  });

  test('账户切换时最高分可从游客分降为零，并只接受当前用户的服务端分', () => {
    const harness = createHarness();
    harness.coordinator.handleAuthChange();
    harness.setSnapshot({ status: 'authenticated', user: { id: '7', username: 'newbie' } });
    harness.coordinator.handleAuthChange();

    assert.equal(harness.coordinator.applyServerBest({ userId: '8', bestScore: 500 }), false);
    assert.equal(harness.coordinator.applyServerBest({ userId: '7', bestScore: 20 }), true);
    assert.deepEqual(harness.displayed, [80, 0, 20]);
  });
});
