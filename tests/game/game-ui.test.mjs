import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createGameController } from '../../client/scripts/game-ui.js';

function createElements() {
  const createElement = () => ({
    textContent: '',
    disabled: false,
    hidden: false,
  });

  return {
    currentScore: createElement(),
    bestScore: createElement(),
    speedLevel: createElement(),
    status: createElement(),
    startButton: createElement(),
    pauseButton: createElement(),
    restartButton: createElement(),
    retryButton: createElement(),
  };
}

function createScheduler() {
  let nextId = 1;
  const active = new Map();
  const created = [];
  const cleared = [];

  function setTimer(callback, delay) {
    const id = nextId;
    nextId += 1;
    active.set(id, callback);
    created.push({ id, callback, delay });
    return id;
  }

  function clearTimer(id) {
    cleared.push(id);
    active.delete(id);
  }

  function currentId() {
    return [...active.keys()].at(-1) ?? null;
  }

  function trigger(id = currentId()) {
    const callback = active.get(id);
    if (!callback) return false;
    callback();
    return true;
  }

  return { active, created, cleared, setTimer, clearTimer, currentId, trigger };
}

function createHarness({
  bestScore = 90,
  now = () => 0,
  onGameFinished = () => undefined,
  random = () => 0,
} = {}) {
  const elements = createElements();
  const scheduler = createScheduler();
  const renderedStates = [];
  const recordedScores = [];
  let storedBestScore = bestScore;
  const renderer = {
    render(state) {
      renderedStates.push(state);
    },
  };
  const scoreStore = {
    getBestScore() {
      return storedBestScore;
    },
    recordScore(score) {
      recordedScores.push(score);
      storedBestScore = Math.max(storedBestScore, score);
      return storedBestScore;
    },
  };
  const controller = createGameController({
    elements,
    renderer,
    scoreStore,
    random,
    now,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onGameFinished,
  });

  return {
    controller,
    elements,
    scheduler,
    renderedStates,
    recordedScores,
  };
}

function advanceToWall(controller, scheduler) {
  controller.start();

  for (let step = 0; step < 11; step += 1) {
    assert.equal(scheduler.trigger(), true);
  }
}

function flushAsyncWork() {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('初始化与运行循环', () => {
  test('初始化真实状态、渲染一次并同步比分和控件', () => {
    const { controller, elements, renderedStates, scheduler } =
      createHarness();

    assert.equal(Object.isFrozen(controller), true);
    assert.deepEqual(Object.keys(controller), [
      'start',
      'togglePause',
      'restart',
      'turn',
      'retryResult',
      'destroy',
      'getState',
    ]);
    assert.equal(controller.getState().status, 'ready');
    assert.equal(controller.getState().level, 1);
    assert.equal(renderedStates.length, 1);
    assert.strictEqual(renderedStates[0], controller.getState());
    assert.equal(elements.currentScore.textContent, '0');
    assert.equal(elements.bestScore.textContent, '90');
    assert.equal(elements.speedLevel.textContent, '1');
    assert.match(elements.status.textContent, /等待开始/);
    assert.equal(elements.startButton.disabled, false);
    assert.equal(elements.pauseButton.disabled, true);
    assert.equal(elements.restartButton.disabled, true);
    assert.equal(elements.retryButton.hidden, true);
    assert.equal(elements.retryButton.disabled, true);
    assert.equal(scheduler.active.size, 0);
  });

  test('开始后按 140 毫秒调度且 tick 使用真实引擎移动', () => {
    const { controller, elements, renderedStates, scheduler } =
      createHarness();

    controller.start();

    assert.equal(controller.getState().status, 'running');
    assert.deepEqual(scheduler.created.map(({ delay }) => delay), [140]);
    assert.equal(scheduler.active.size, 1);
    assert.equal(elements.startButton.disabled, true);
    assert.equal(elements.pauseButton.disabled, false);
    assert.equal(elements.restartButton.disabled, false);
    assert.match(elements.status.textContent, /向右/);
    assert.match(elements.status.textContent, /0/);

    assert.equal(scheduler.trigger(), true);

    assert.deepEqual(controller.getState().snake[0], { x: 10, y: 10 });
    assert.equal(renderedStates.length, 3);
  });

  test('转向、暂停和继续保留同一局状态并重建计时器', () => {
    const { controller, elements, scheduler } = createHarness();

    controller.start();
    const firstTimerId = scheduler.currentId();
    controller.turn('up');
    const snakeBeforePause = controller.getState().snake;
    controller.togglePause();

    assert.equal(controller.getState().status, 'paused');
    assert.equal(controller.getState().direction, 'up');
    assert.strictEqual(controller.getState().snake, snakeBeforePause);
    assert.equal(scheduler.active.size, 0);
    assert.deepEqual(scheduler.cleared, [firstTimerId]);
    assert.equal(elements.pauseButton.disabled, false);
    assert.equal(elements.pauseButton.textContent, '继续');
    assert.match(elements.status.textContent, /暂停/);

    controller.togglePause();

    assert.equal(controller.getState().status, 'running');
    assert.equal(controller.getState().direction, 'up');
    assert.equal(elements.pauseButton.textContent, '暂停');
    assert.equal(scheduler.active.size, 1);
    assert.notEqual(scheduler.currentId(), firstTimerId);
    assert.equal(scheduler.trigger(), true);
    assert.deepEqual(controller.getState().snake[0], { x: 9, y: 9 });
  });
});

describe('结束上报与重试', () => {
  test('撞墙后停止计时、记录成绩并异步上报冻结结果', async () => {
    const callbackResults = [];
    const times = [1_000, 1_534.4];
    const { controller, elements, scheduler, recordedScores } = createHarness({
      now: () => times.shift(),
      onGameFinished(result) {
        callbackResults.push(result);
      },
    });

    advanceToWall(controller, scheduler);

    assert.equal(controller.getState().status, 'game-over');
    assert.equal(controller.getState().outcome, 'wall');
    assert.equal(scheduler.active.size, 0);
    assert.deepEqual(recordedScores, [0]);
    assert.equal(callbackResults.length, 0, '结束回调不应阻塞 tick');
    assert.match(elements.status.textContent, /撞墙/);
    assert.equal(elements.pauseButton.disabled, true);
    assert.equal(elements.restartButton.disabled, false);

    await flushAsyncWork();

    assert.equal(callbackResults.length, 1);
    assert.deepEqual(callbackResults[0], {
      score: 0,
      durationMs: 534,
      outcome: 'wall',
    });
    assert.equal(Object.isFrozen(callbackResults[0]), true);
  });

  test('上报失败显示重试，重试成功恢复结束文案且重开清除结果', async () => {
    const submittedResults = [];
    const { controller, elements, scheduler } = createHarness({
      onGameFinished(result) {
        submittedResults.push(result);
        if (submittedResults.length === 1) {
          throw new Error('网络暂不可用');
        }
        return Promise.resolve();
      },
    });

    advanceToWall(controller, scheduler);
    await flushAsyncWork();

    assert.equal(submittedResults.length, 1);
    assert.equal(elements.retryButton.hidden, false);
    assert.equal(elements.retryButton.disabled, false);
    assert.equal(
      elements.status.textContent,
      '成绩暂未保存，可点击‘重试提交成绩’。',
    );

    const retryPromise = controller.retryResult();
    assert.ok(retryPromise instanceof Promise);
    await retryPromise;

    assert.equal(submittedResults.length, 2);
    assert.strictEqual(submittedResults[1], submittedResults[0]);
    assert.equal(elements.retryButton.hidden, true);
    assert.equal(elements.retryButton.disabled, true);
    assert.match(elements.status.textContent, /撞墙/);

    controller.restart();
    const attemptsAfterRestart = submittedResults.length;
    await controller.retryResult();

    assert.equal(controller.getState().status, 'running');
    assert.equal(submittedResults.length, attemptsAfterRestart);
    assert.equal(elements.retryButton.hidden, true);
  });

  test('重复重试复用同一提交并在等待期间禁用重试按钮', async () => {
    let finishRetry;
    const retryPending = new Promise((resolve) => {
      finishRetry = resolve;
    });
    const submittedResults = [];
    const { controller, elements, scheduler } = createHarness({
      onGameFinished(result) {
        submittedResults.push(result);
        if (submittedResults.length === 1) {
          throw new Error('首次提交失败');
        }
        return retryPending;
      },
    });

    advanceToWall(controller, scheduler);
    await flushAsyncWork();

    const firstRetry = controller.retryResult();
    const duplicateRetry = controller.retryResult();
    await Promise.resolve();

    try {
      assert.strictEqual(duplicateRetry, firstRetry);
      assert.equal(submittedResults.length, 2);
      assert.equal(elements.retryButton.hidden, false);
      assert.equal(elements.retryButton.disabled, true);
    } finally {
      finishRetry();
    }

    await firstRetry;

    assert.equal(elements.retryButton.hidden, true);
    assert.equal(elements.retryButton.disabled, true);
    assert.match(elements.status.textContent, /撞墙/);
  });
});

describe('重开、升级调度与销毁', () => {
  test('重开清除旧计时器、立即运行新状态且仅新计时器有效', () => {
    const { controller, scheduler } = createHarness();

    controller.start();
    controller.turn('up');
    const oldTimerId = scheduler.currentId();
    controller.restart();
    const newTimerId = scheduler.currentId();

    assert.equal(controller.getState().status, 'running');
    assert.equal(controller.getState().direction, 'right');
    assert.equal(controller.getState().score, 0);
    assert.deepEqual(controller.getState().snake[0], { x: 9, y: 10 });
    assert.deepEqual(scheduler.created.map(({ delay }) => delay), [140, 140]);
    assert.deepEqual(scheduler.cleared, [oldTimerId]);
    assert.notEqual(newTimerId, oldTimerId);

    assert.equal(scheduler.trigger(oldTimerId), false);
    assert.deepEqual(controller.getState().snake[0], { x: 9, y: 10 });
    assert.equal(scheduler.trigger(newTimerId), true);
    assert.deepEqual(controller.getState().snake[0], { x: 10, y: 10 });
  });

  test('吃到第五个食物时从 140 改为 130 毫秒并重新调度', () => {
    const randomValues = [396, 395, 394, 393, 392].map(
      (freeCellCount) => 206.5 / freeCellCount,
    );
    const { controller, scheduler } = createHarness({
      random: () => randomValues.shift() ?? 0,
    });

    controller.start();
    const levelOneTimerId = scheduler.currentId();

    for (let food = 0; food < 5; food += 1) {
      assert.equal(scheduler.trigger(), true);
    }

    assert.equal(controller.getState().score, 50);
    assert.equal(controller.getState().foodCount, 5);
    assert.equal(controller.getState().level, 2);
    assert.equal(controller.getState().intervalMs, 130);
    assert.deepEqual(scheduler.created.map(({ delay }) => delay), [140, 130]);
    assert.deepEqual(scheduler.cleared, [levelOneTimerId]);
    assert.equal(scheduler.active.size, 1);
  });

  test('destroy 幂等清理活动计时器且无结果重试立即完成', async () => {
    const { controller, scheduler } = createHarness();

    const emptyRetry = controller.retryResult();
    assert.ok(emptyRetry instanceof Promise);
    await emptyRetry;

    controller.start();
    const timerId = scheduler.currentId();
    controller.destroy();
    controller.destroy();

    assert.deepEqual(scheduler.cleared, [timerId]);
    assert.equal(scheduler.active.size, 0);
    assert.equal(scheduler.trigger(timerId), false);
  });
});
