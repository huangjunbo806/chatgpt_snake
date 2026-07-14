import {
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
  random = Math.random,
  now = () => Date.now(),
  setTimer = (callback, delay) => globalThis.setInterval(callback, delay),
  clearTimer = (id) => globalThis.clearInterval(id),
  onGameFinished = () => undefined,
}) {
  let state = createInitialState(random);
  let bestScore = scoreStore.getBestScore();
  let activeTimerId = null;
  let timerGeneration = 0;
  let startedAtMs = null;
  let finishedResult = null;
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
    elements.status.textContent = resultSubmissionFailed
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

  function submitResult(result) {
    if (!result) return Promise.resolve();

    resultSubmissionPending = true;
    submissionPromise = Promise.resolve()
      .then(() => onGameFinished(result))
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
    scoreStore.recordScore(state.score);
    bestScore = scoreStore.getBestScore();
    finishedResult = Object.freeze({
      score: state.score,
      durationMs: Math.max(0, Math.round(now() - startedAtMs)),
      outcome: state.outcome,
    });
    resultSubmissionFailed = false;
    resultSubmissionPending = false;
    submissionPromise = null;
    renderView();
    void submitResult(finishedResult);
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
    state = startGame(restartGame(random));
    startedAtMs = now();
    finishedResult = null;
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
    return submitResult(finishedResult);
  }

  function destroy() {
    if (destroyed) return;

    destroyed = true;
    finishedResult = null;
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
    destroy,
    getState,
  });
}
