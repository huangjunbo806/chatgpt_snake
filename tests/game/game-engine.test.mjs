import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  BOARD_SIZE,
  FOODS_PER_LEVEL,
  INITIAL_INTERVAL_MS,
  INITIAL_SNAKE_LENGTH,
  MAX_SCORE,
  MIN_INTERVAL_MS,
  SCORE_PER_FOOD,
  SPEED_STEP_MS,
  createInitialState,
  pauseGame,
  pickFoodCell,
  requestDirection,
  restartGame,
  resumeGame,
  startGame,
  stepGame,
} from '../../client/scripts/game-engine.js';

const INITIAL_SNAKE = [
  { x: 9, y: 10 },
  { x: 8, y: 10 },
  { x: 7, y: 10 },
  { x: 6, y: 10 },
];

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeRunningState(overrides = {}) {
  return {
    ...startGame(createInitialState(() => 0)),
    ...overrides,
  };
}

describe('常量、初始状态和食物生成', () => {
  test('导出固定棋盘与计分常量', () => {
    assert.equal(BOARD_SIZE, 20);
    assert.equal(INITIAL_INTERVAL_MS, 140);
    assert.equal(MIN_INTERVAL_MS, 70);
    assert.equal(SPEED_STEP_MS, 10);
    assert.equal(FOODS_PER_LEVEL, 5);
    assert.equal(SCORE_PER_FOOD, 10);
    assert.equal(INITIAL_SNAKE_LENGTH, 4);
    assert.equal(MAX_SCORE, 3960);
  });

  test('创建确定的初始状态且不共享蛇数组', () => {
    const first = createInitialState(() => 0);
    const second = createInitialState(() => 0);

    assert.deepEqual(first, {
      snake: INITIAL_SNAKE,
      direction: 'right',
      food: { x: 0, y: 0 },
      status: 'ready',
      score: 0,
      foodCount: 0,
      level: 1,
      intervalMs: 140,
      turnAccepted: false,
    });
    assert.notStrictEqual(first, second);
    assert.notStrictEqual(first.snake, second.snake);
    assert.notStrictEqual(first.snake[0], second.snake[0]);
  });

  test('食物只从空格中选择并安全夹取越界随机值', () => {
    const snake = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
    ];
    const before = clone(snake);

    assert.deepEqual(pickFoodCell(snake, () => -3), { x: 2, y: 0 });
    assert.deepEqual(pickFoodCell(snake, () => Number.NaN), {
      x: 2,
      y: 0,
    });
    assert.deepEqual(pickFoodCell(snake, () => Number.POSITIVE_INFINITY), {
      x: 2,
      y: 0,
    });
    assert.deepEqual(pickFoodCell(snake, () => 1), { x: 19, y: 19 });
    assert.deepEqual(pickFoodCell(snake, () => 9), { x: 19, y: 19 });
    assert.deepEqual(snake, before);
  });

  test('棋盘没有空格时不再生成食物', () => {
    const fullSnake = Array.from(
      { length: BOARD_SIZE * BOARD_SIZE },
      (_, index) => ({
        x: index % BOARD_SIZE,
        y: Math.floor(index / BOARD_SIZE),
      }),
    );

    assert.equal(pickFoodCell(fullSnake, () => 0.5), null);
  });
});

describe('开始、暂停、恢复和重开', () => {
  test('生命周期更新返回新状态且不修改输入', () => {
    const ready = createInitialState(() => 0);
    const readyBefore = clone(ready);
    const running = startGame(ready);

    assert.equal(running.status, 'running');
    assert.notStrictEqual(running, ready);
    assert.deepEqual(ready, readyBefore);

    const runningBefore = clone(running);
    const paused = pauseGame(running);

    assert.equal(paused.status, 'paused');
    assert.notStrictEqual(paused, running);
    assert.deepEqual(running, runningBefore);

    const pausedBefore = clone(paused);
    const resumed = resumeGame(paused);

    assert.equal(resumed.status, 'running');
    assert.notStrictEqual(resumed, paused);
    assert.deepEqual(paused, pausedBefore);
  });

  test('不适用的生命周期操作保持原状态引用', () => {
    const ready = createInitialState(() => 0);
    const running = startGame(ready);

    assert.strictEqual(startGame(running), running);
    assert.strictEqual(pauseGame(ready), ready);
    assert.strictEqual(resumeGame(ready), ready);
    assert.strictEqual(resumeGame(running), running);
  });

  test('重新开始会创建全新的 ready 状态', () => {
    const state = makeRunningState({
      score: 80,
      foodCount: 8,
      level: 2,
      intervalMs: 130,
    });
    const restarted = restartGame(() => 0);

    assert.deepEqual(restarted, createInitialState(() => 0));
    assert.notStrictEqual(restarted, state);
    assert.notStrictEqual(restarted.snake, state.snake);
  });

  test('非 running 状态不会移动', () => {
    const running = makeRunningState();
    const states = [
      createInitialState(() => 0),
      pauseGame(running),
      { ...running, status: 'gameover' },
      { ...running, status: 'won', food: null },
    ];

    for (const state of states) {
      const before = clone(state);
      const result = stepGame(state, () => 0);

      assert.strictEqual(result, state);
      assert.deepEqual(state, before);
    }
  });
});

describe('方向请求和普通移动', () => {
  test('无效、反向和同方向输入不改变状态', () => {
    const state = makeRunningState();

    for (const direction of ['north', '', null, undefined, 42]) {
      assert.strictEqual(requestDirection(state, direction), state);
    }
    assert.strictEqual(requestDirection(state, 'left'), state);
    assert.strictEqual(requestDirection(state, 'right'), state);
    assert.equal(state.turnAccepted, false);
  });

  test('每步只接受一次真正合法的转向', () => {
    const state = makeRunningState();
    const turned = requestDirection(state, 'up');

    assert.notStrictEqual(turned, state);
    assert.equal(turned.direction, 'up');
    assert.equal(turned.turnAccepted, true);
    assert.equal(state.direction, 'right');
    assert.equal(state.turnAccepted, false);

    assert.strictEqual(requestDirection(turned, 'left'), turned);
    assert.strictEqual(requestDirection(turned, 'right'), turned);

    const moved = stepGame(turned, () => 0);
    assert.deepEqual(moved.snake[0], { x: 9, y: 9 });
    assert.equal(moved.turnAccepted, false);
  });

  test('同方向输入不会消耗本步的合法转向', () => {
    const state = makeRunningState();
    const sameDirection = requestDirection(state, 'right');

    assert.strictEqual(sameDirection, state);
    assert.equal(sameDirection.turnAccepted, false);

    const turned = requestDirection(sameDirection, 'down');
    assert.equal(turned.direction, 'down');
    assert.equal(turned.turnAccepted, true);

    const moved = stepGame(turned, () => 0);
    assert.deepEqual(moved.snake[0], { x: 9, y: 11 });
  });

  test('蛇可以向四个方向各移动一格', () => {
    const vectors = {
      up: { x: 10, y: 9 },
      down: { x: 10, y: 11 },
      left: { x: 9, y: 10 },
      right: { x: 11, y: 10 },
    };

    for (const [direction, expectedHead] of Object.entries(vectors)) {
      const state = makeRunningState({
        snake: [
          { x: 10, y: 10 },
          { x: 0, y: 0 },
          { x: 0, y: 1 },
          { x: 0, y: 2 },
        ],
        direction,
        food: { x: 19, y: 19 },
      });
      const moved = stepGame(state, () => 0);

      assert.deepEqual(moved.snake[0], expectedHead);
      assert.equal(moved.snake.length, INITIAL_SNAKE_LENGTH);
    }
  });

  test('普通移动返回新状态且不修改原 state 或 snake', () => {
    const state = makeRunningState();
    const before = clone(state);
    const moved = stepGame(state, () => 0);

    assert.notStrictEqual(moved, state);
    assert.notStrictEqual(moved.snake, state.snake);
    assert.deepEqual(moved.snake, [
      { x: 10, y: 10 },
      { x: 9, y: 10 },
      { x: 8, y: 10 },
      { x: 7, y: 10 },
    ]);
    assert.deepEqual(state, before);
  });
});

describe('碰撞规则', () => {
  test('撞墙后结束且不会写入棋盘外的非法蛇头', () => {
    const state = makeRunningState({
      snake: [
        { x: 19, y: 10 },
        { x: 18, y: 10 },
        { x: 17, y: 10 },
        { x: 16, y: 10 },
      ],
      food: { x: 0, y: 0 },
    });
    const before = clone(state);
    const result = stepGame(state, () => 0);

    assert.equal(result.status, 'gameover');
    assert.deepEqual(result.snake, state.snake);
    assert.equal(result.snake.some((cell) => cell.x === 20), false);
    assert.deepEqual(state, before);
  });

  test('撞到不会离开的身体后结束', () => {
    const state = makeRunningState({
      snake: [
        { x: 2, y: 1 },
        { x: 1, y: 1 },
        { x: 1, y: 2 },
        { x: 2, y: 2 },
        { x: 3, y: 2 },
        { x: 3, y: 1 },
      ],
      direction: 'down',
      food: { x: 10, y: 10 },
    });
    const result = stepGame(state, () => 0);

    assert.equal(result.status, 'gameover');
    assert.deepEqual(result.snake, state.snake);
  });

  test('允许移动到本步即将离开的尾格', () => {
    const state = makeRunningState({
      snake: [
        { x: 1, y: 1 },
        { x: 2, y: 1 },
        { x: 2, y: 2 },
        { x: 1, y: 2 },
      ],
      direction: 'down',
      food: { x: 10, y: 10 },
    });
    const result = stepGame(state, () => 0);

    assert.equal(result.status, 'running');
    assert.deepEqual(result.snake, [
      { x: 1, y: 2 },
      { x: 1, y: 1 },
      { x: 2, y: 1 },
      { x: 2, y: 2 },
    ]);
  });
});

describe('进食、计分和速度等级', () => {
  test('吃到食物后增长、加分并只在空格生成新食物', () => {
    const state = makeRunningState({ food: { x: 10, y: 10 } });
    const before = clone(state);
    const result = stepGame(state, () => 0);

    assert.equal(result.status, 'running');
    assert.equal(result.snake.length, INITIAL_SNAKE_LENGTH + 1);
    assert.deepEqual(result.snake[0], { x: 10, y: 10 });
    assert.equal(result.score, SCORE_PER_FOOD);
    assert.equal(result.foodCount, 1);
    assert.equal(result.level, 1);
    assert.equal(result.intervalMs, INITIAL_INTERVAL_MS);
    assert.deepEqual(result.food, { x: 0, y: 0 });
    assert.equal(
      result.snake.some(
        (cell) => cell.x === result.food.x && cell.y === result.food.y,
      ),
      false,
    );
    assert.deepEqual(state, before);
  });

  test('每吃五个食物升级并缩短十毫秒', () => {
    const state = makeRunningState({
      food: { x: 10, y: 10 },
      score: 40,
      foodCount: FOODS_PER_LEVEL - 1,
    });
    const result = stepGame(state, () => 0);

    assert.equal(result.score, 50);
    assert.equal(result.foodCount, 5);
    assert.equal(result.level, 2);
    assert.equal(result.intervalMs, INITIAL_INTERVAL_MS - SPEED_STEP_MS);
  });

  test('速度最低为七十毫秒且等级最高为八级', () => {
    const levelEight = stepGame(
      makeRunningState({
        food: { x: 10, y: 10 },
        score: 340,
        foodCount: 34,
        level: 7,
        intervalMs: 80,
      }),
      () => 0,
    );

    assert.equal(levelEight.foodCount, 35);
    assert.equal(levelEight.level, 8);
    assert.equal(levelEight.intervalMs, MIN_INTERVAL_MS);

    const capped = stepGame(
      makeRunningState({
        food: { x: 10, y: 10 },
        score: 390,
        foodCount: 39,
        level: 8,
        intervalMs: MIN_INTERVAL_MS,
      }),
      () => 0,
    );

    assert.equal(capped.foodCount, 40);
    assert.equal(capped.level, 8);
    assert.equal(capped.intervalMs, MIN_INTERVAL_MS);
  });
});

describe('满盘胜利', () => {
  test('占满四百格后进入 won 并达到理论最高分', () => {
    const food = { x: 19, y: 19 };
    const head = { x: 18, y: 19 };
    const rest = [];

    for (let y = 0; y < BOARD_SIZE; y += 1) {
      for (let x = 0; x < BOARD_SIZE; x += 1) {
        const isHead = x === head.x && y === head.y;
        const isFood = x === food.x && y === food.y;
        if (!isHead && !isFood) rest.push({ x, y });
      }
    }

    const state = makeRunningState({
      snake: [head, ...rest],
      direction: 'right',
      food,
      score: MAX_SCORE - SCORE_PER_FOOD,
      foodCount: BOARD_SIZE * BOARD_SIZE - INITIAL_SNAKE_LENGTH - 1,
      level: 8,
      intervalMs: MIN_INTERVAL_MS,
    });
    const before = clone(state);
    const result = stepGame(state, () => 0.5);

    assert.equal(state.snake.length, 399);
    assert.equal(result.snake.length, 400);
    assert.equal(result.status, 'won');
    assert.equal(result.score, MAX_SCORE);
    assert.equal(result.foodCount, 396);
    assert.equal(result.level, 8);
    assert.equal(result.intervalMs, MIN_INTERVAL_MS);
    assert.equal(result.food, null);
    assert.deepEqual(result.snake[0], food);
    assert.deepEqual(state, before);
  });
});
