import {
  MIN_INTERVAL_MS,
  SCORE_PER_FOOD,
  createInitialState,
  pauseGame,
  requestDirection,
  restartGame,
  resumeGame,
  startGame,
  stepGame,
} from './game-engine.js';

const DIRECTION_TEXT = Object.freeze({
  up: '上',
  down: '下',
  left: '左',
  right: '右',
});

const RETRY_STATUS = '成绩暂未保存，可点击‘重试提交成绩’。';
const SUBMITTING_STATUS = '成绩正在提交，请稍候。';
const MAX_DURATION_MS = 86_400_000;

function defaultNow() {
  if (typeof globalThis.performance?.now === 'function') {
    return globalThis.performance.now();
  }

  return Date.now();
}

function normalizedDurationMs(score, startedAtMs, finishedAtMs) {
  const numericScore = Number(score);
  const minimumDurationMs =
    Number.isFinite(numericScore) && numericScore > 0
      ? Math.min(
          MAX_DURATION_MS,
          Math.ceil((numericScore / SCORE_PER_FOOD) * MIN_INTERVAL_MS),
        )
      : 0;
  const elapsedMs = Number(finishedAtMs) - Number(startedAtMs);
  const roundedElapsedMs = Number.isFinite(elapsedMs)
    ? Math.round(elapsedMs)
    : minimumDurationMs;

  return Math.min(
    MAX_DURATION_MS,
    Math.max(0, minimumDurationMs, roundedElapsedMs),
  );
}

function naturalStatusText(state) {
  if (state.status === 'ready') {
    return '等待开始，点击“开始游戏”进入本局。';
  }

  if (state.status === 'running') {
    const direction = DIRECTION_TEXT[state.direction] ?? state.direction;
    return `游戏进行中：向${direction}移动，当前得分 ${state.score}。`;
  }

  if (state.status === 'paused') {
    return `游戏已暂停，当前得分 ${state.score}。`;
  }

  if (state.status === 'won' || state.outcome === 'won') {
    return `棋盘已占满，你赢了！最终得分 ${state.score}。`;
  }

  if (state.outcome === 'wall') {
    return `撞墙了，游戏结束！最终得分 ${state.score}。`;
  }

  if (state.outcome === 'self') {
    return `撞到自己了，游戏结束！最终得分 ${state.score}。`;
  }

  return `游戏结束，最终得分 ${state.score}。`;
}

export function createGameController({
  elements,
  renderer,
  scoreStore,
  initialBestScore,
  random = Math.random,
  now = defaultNow,
  setTimer = (callback, delay) => globalThis.setInterval(callback, delay),
  clearTimer = (id) => globalThis.clearInterval(id),
  onRoundStarted = () => Object.freeze({ kind: 'guest' }),
  onGameFinished = () => undefined,
}) {
  let state = createInitialState(random);
  let bestScore = Number.isInteger(initialBestScore) && initialBestScore >= 0
    ? initialBestScore
    : scoreStore?.getBestScore?.() ?? 0;
  let activeTimerId = null;
  let timerGeneration = 0;
  let startedAtMs = null;
  let activeRoundOwner = null;
  let finishedResult = null;
  let finishedRoundOwner = null;
  let resultSubmissionFailed = false;
  let resultSubmissionPending = false;
  let submissionPromise = null;
  let destroyed = false;

  function updateElements() {
    const isReady = state.status === 'ready';
    const canPause = state.status === 'running' || state.status === 'paused';

    elements.currentScore.textContent = String(state.score);
    elements.bestScore.textContent = String(bestScore);
    elements.speedLevel.textContent = String(state.level);
    elements.status.textContent =
      resultSubmissionFailed && resultSubmissionPending
        ? SUBMITTING_STATUS
        : resultSubmissionFailed
          ? RETRY_STATUS
          : naturalStatusText(state);
    elements.startButton.disabled = !isReady;
    elements.pauseButton.disabled = !canPause;
    elements.pauseButton.textContent =
      state.status === 'paused' ? '继续' : '暂停';
    elements.restartButton.disabled = isReady;
    elements.retryButton.hidden = !resultSubmissionFailed;
    elements.retryButton.disabled =
      !resultSubmissionFailed || resultSubmissionPending;
  }

  function renderView() {
    renderer.render(state);
    updateElements();
  }

  function stopTimer() {
    if (activeTimerId === null) return;

    const timerId = activeTimerId;
    activeTimerId = null;
    timerGeneration += 1;
    clearTimer(timerId);
  }

  function scheduleTimer() {
    const generation = timerGeneration + 1;
    timerGeneration = generation;
    activeTimerId = setTimer(() => {
      if (
        destroyed ||
        activeTimerId === null ||
        generation !== timerGeneration
      ) {
        return;
      }

      tick();
    }, state.intervalMs);
  }

  function submitResult(result, roundOwner) {
    if (!result) return Promise.resolve();

    resultSubmissionPending = true;
    submissionPromise = Promise.resolve()
      .then(() => onGameFinished(result, roundOwner))
      .then(
        () => {
          if (destroyed || finishedResult !== result) return;
          resultSubmissionFailed = false;
          resultSubmissionPending = false;
          submissionPromise = null;
          updateElements();
        },
        () => {
          if (destroyed || finishedResult !== result) return;
          resultSubmissionFailed = true;
          resultSubmissionPending = false;
          submissionPromise = null;
          updateElements();
        },
      );
    updateElements();
    return submissionPromise;
  }

  function finishGame() {
    stopTimer();
    if (scoreStore?.recordScore && scoreStore?.getBestScore) {
      scoreStore.recordScore(state.score);
      bestScore = scoreStore.getBestScore();
    }
    finishedResult = Object.freeze({
      score: state.score,
      durationMs: normalizedDurationMs(state.score, startedAtMs, now()),
      outcome: state.outcome,
    });
    finishedRoundOwner = activeRoundOwner;
    resultSubmissionFailed = false;
    resultSubmissionPending = false;
    submissionPromise = null;
    renderView();
    void submitResult(finishedResult, finishedRoundOwner);
  }

  function tick() {
    if (destroyed || state.status !== 'running') return;

    const previousIntervalMs = state.intervalMs;
    state = stepGame(state, random);

    if (state.status === 'game-over' || state.status === 'won') {
      finishGame();
      return;
    }

    renderView();

    if (state.intervalMs !== previousIntervalMs) {
      stopTimer();
      scheduleTimer();
    }
  }

  function start() {
    if (destroyed || state.status !== 'ready') return;

    activeRoundOwner = onRoundStarted();
    state = startGame(state);
    startedAtMs = now();
    scheduleTimer();
    renderView();
  }

  function togglePause() {
    if (destroyed) return;

    if (state.status === 'running') {
      stopTimer();
      state = pauseGame(state);
      renderView();
      return;
    }

    if (state.status === 'paused') {
      state = resumeGame(state);
      scheduleTimer();
      renderView();
    }
  }

  function restart() {
    if (destroyed) return;

    stopTimer();
    activeRoundOwner = onRoundStarted();
    state = startGame(restartGame(random));
    startedAtMs = now();
    finishedResult = null;
    finishedRoundOwner = null;
    resultSubmissionFailed = false;
    resultSubmissionPending = false;
    submissionPromise = null;
    scheduleTimer();
    renderView();
  }

  function turn(direction) {
    if (destroyed) return;

    const nextState = requestDirection(state, direction);
    if (nextState === state) return;

    state = nextState;
    renderView();
  }

  function retryResult() {
    if (!finishedResult) return Promise.resolve();
    if (resultSubmissionPending) return submissionPromise;
    if (!resultSubmissionFailed) return Promise.resolve();
    return submitResult(finishedResult, finishedRoundOwner);
  }

  function setBestScore(score) {
    if (destroyed || !Number.isInteger(score) || score < 0) return;
    bestScore = score;
    updateElements();
  }

  function destroy() {
    if (destroyed) return;

    destroyed = true;
    finishedResult = null;
    finishedRoundOwner = null;
    activeRoundOwner = null;
    resultSubmissionFailed = false;
    resultSubmissionPending = false;
    submissionPromise = null;
    stopTimer();
  }

  function getState() {
    return state;
  }

  renderView();

  return Object.freeze({
    start,
    togglePause,
    restart,
    turn,
    retryResult,
    setBestScore,
    destroy,
    getState,
  });
}
