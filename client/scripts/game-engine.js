export const BOARD_SIZE = 20;
export const INITIAL_INTERVAL_MS = 140;
export const MIN_INTERVAL_MS = 70;
export const SPEED_STEP_MS = 10;
export const FOODS_PER_LEVEL = 5;
export const SCORE_PER_FOOD = 10;
export const INITIAL_SNAKE_LENGTH = 4;
export const MAX_SCORE = 3960;

const MAX_LEVEL =
  (INITIAL_INTERVAL_MS - MIN_INTERVAL_MS) / SPEED_STEP_MS + 1;
const MAX_FOOD_COUNT = BOARD_SIZE * BOARD_SIZE - INITIAL_SNAKE_LENGTH;

const DIRECTIONS = Object.freeze({
  up: Object.freeze({ x: 0, y: -1 }),
  down: Object.freeze({ x: 0, y: 1 }),
  left: Object.freeze({ x: -1, y: 0 }),
  right: Object.freeze({ x: 1, y: 0 }),
});

const OPPOSITE_DIRECTIONS = Object.freeze({
  up: 'down',
  down: 'up',
  left: 'right',
  right: 'left',
});

const INITIAL_SNAKE = Object.freeze([
  Object.freeze({ x: 9, y: 10 }),
  Object.freeze({ x: 8, y: 10 }),
  Object.freeze({ x: 7, y: 10 }),
  Object.freeze({ x: 6, y: 10 }),
]);

function sameCell(first, second) {
  return first.x === second.x && first.y === second.y;
}

function cellKey(cell) {
  return cell.x + ',' + cell.y;
}

function randomIndex(random, length) {
  let value = 0;

  try {
    value = Number(random());
  } catch {
    value = 0;
  }

  if (!Number.isFinite(value)) value = 0;

  const clamped = Math.min(Math.max(value, 0), 1);
  return Math.min(length - 1, Math.floor(clamped * length));
}

function levelForFoodCount(foodCount) {
  const earnedLevels = Math.floor(Math.max(0, foodCount) / FOODS_PER_LEVEL);
  return Math.min(MAX_LEVEL, earnedLevels + 1);
}

function intervalForLevel(level) {
  return Math.max(
    MIN_INTERVAL_MS,
    INITIAL_INTERVAL_MS - (level - 1) * SPEED_STEP_MS,
  );
}

function endedState(state) {
  return {
    ...state,
    status: 'game-over',
    turnAccepted: false,
  };
}

export function pickFoodCell(snake, random = Math.random) {
  const occupied = new Set(snake.map(cellKey));
  const freeCells = [];

  for (let y = 0; y < BOARD_SIZE; y += 1) {
    for (let x = 0; x < BOARD_SIZE; x += 1) {
      const cell = { x, y };
      if (!occupied.has(cellKey(cell))) freeCells.push(cell);
    }
  }

  if (freeCells.length === 0) return null;

  const randomSource = typeof random === 'function' ? random : Math.random;
  return freeCells[randomIndex(randomSource, freeCells.length)];
}

export function createInitialState(random = Math.random) {
  const snake = INITIAL_SNAKE.map((cell) => ({ ...cell }));

  return {
    snake,
    direction: 'right',
    food: pickFoodCell(snake, random),
    status: 'ready',
    score: 0,
    foodCount: 0,
    level: 1,
    intervalMs: INITIAL_INTERVAL_MS,
    turnAccepted: false,
  };
}

export function startGame(state) {
  if (state.status !== 'ready') return state;

  return {
    ...state,
    status: 'running',
    turnAccepted: false,
  };
}

export function pauseGame(state) {
  if (state.status !== 'running') return state;

  return {
    ...state,
    status: 'paused',
  };
}

export function resumeGame(state) {
  if (state.status !== 'paused') return state;

  return {
    ...state,
    status: 'running',
  };
}

export function restartGame(random = Math.random) {
  return createInitialState(random);
}

export function requestDirection(state, nextDirection) {
  const isKnownDirection = Object.hasOwn(DIRECTIONS, nextDirection);

  if (
    state.status !== 'running' ||
    state.turnAccepted ||
    !isKnownDirection ||
    nextDirection === state.direction ||
    OPPOSITE_DIRECTIONS[state.direction] === nextDirection
  ) {
    return state;
  }

  return {
    ...state,
    direction: nextDirection,
    turnAccepted: true,
  };
}

export function stepGame(state, random = Math.random) {
  if (state.status !== 'running') return state;

  const movement = DIRECTIONS[state.direction];
  const currentHead = state.snake[0];
  const nextHead = {
    x: currentHead.x + movement.x,
    y: currentHead.y + movement.y,
  };
  const hitWall =
    nextHead.x < 0 ||
    nextHead.x >= BOARD_SIZE ||
    nextHead.y < 0 ||
    nextHead.y >= BOARD_SIZE;

  if (hitWall) return endedState(state);

  const ateFood = state.food !== null && sameCell(nextHead, state.food);
  const collisionBody = ateFood ? state.snake : state.snake.slice(0, -1);
  const hitSelf = collisionBody.some((cell) => sameCell(cell, nextHead));

  if (hitSelf) return endedState(state);

  const nextSnake = ateFood
    ? [nextHead, ...state.snake]
    : [nextHead, ...state.snake.slice(0, -1)];

  if (!ateFood) {
    return {
      ...state,
      snake: nextSnake,
      turnAccepted: false,
    };
  }

  const won = nextSnake.length >= BOARD_SIZE * BOARD_SIZE;

  if (won) {
    return {
      ...state,
      snake: nextSnake,
      food: null,
      status: 'won',
      score: MAX_SCORE,
      foodCount: MAX_FOOD_COUNT,
      level: MAX_LEVEL,
      intervalMs: MIN_INTERVAL_MS,
      turnAccepted: false,
    };
  }

  const foodCount = Math.min(MAX_FOOD_COUNT, state.foodCount + 1);
  const level = levelForFoodCount(foodCount);

  return {
    ...state,
    snake: nextSnake,
    food: pickFoodCell(nextSnake, random),
    score: Math.min(MAX_SCORE, state.score + SCORE_PER_FOOD),
    foodCount,
    level,
    intervalMs: intervalForLevel(level),
    turnAccepted: false,
  };
}
