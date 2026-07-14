import { createCanvasRenderer } from './canvas-renderer.js';
import { createGameController } from './game-ui.js';
import { createGuestScoreStore } from './guest-score.js';
import { createInputController } from './input-controller.js';

const REQUIRED_ELEMENT_IDS = Object.freeze([
  'game-canvas',
  'current-score',
  'best-score',
  'speed-level',
  'game-status',
  'start-game',
  'toggle-pause',
  'restart-game',
  'retry-score',
  'touch-controls',
]);

export function initializeGameApp(
  {
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    createRenderer = createCanvasRenderer,
    createScoreStore = createGuestScoreStore,
    createController = createGameController,
    createInput = createInputController,
    onGameFinished = () => undefined,
  } = {},
) {
  const requiredElements = {};

  for (const id of REQUIRED_ELEMENT_IDS) {
    const element = documentRef?.querySelector?.(`#${id}`);

    if (!element) {
      throw new Error(`找不到 #${id}，无法启动游戏。`);
    }

    requiredElements[id] = element;
  }

  if (documentRef?.documentElement?.dataset) {
    documentRef.documentElement.dataset.javascript = 'enabled';
  }

  const renderer = createRenderer(requiredElements['game-canvas']);
  const scoreStore = createScoreStore();
  const controller = createController({
    elements: {
      currentScore: requiredElements['current-score'],
      bestScore: requiredElements['best-score'],
      speedLevel: requiredElements['speed-level'],
      status: requiredElements['game-status'],
      startButton: requiredElements['start-game'],
      pauseButton: requiredElements['toggle-pause'],
      restartButton: requiredElements['restart-game'],
      retryButton: requiredElements['retry-score'],
    },
    renderer,
    scoreStore,
    onGameFinished,
  });
  const inputController = createInput({
    documentObject: documentRef,
    touchRoot: requiredElements['touch-controls'],
    onDirection: (direction) => controller.turn(direction),
    onTogglePause: () => controller.togglePause(),
    onRestart: () => controller.restart(),
    onStart: () => controller.start(),
    onPageHidden: () => {
      if (controller.getState().status === 'running') {
        controller.togglePause();
      }
    },
  });

  const startButton = requiredElements['start-game'];
  const pauseButton = requiredElements['toggle-pause'];
  const restartButton = requiredElements['restart-game'];
  const retryButton = requiredElements['retry-score'];
  const handleStart = () => controller.start();
  const handleTogglePause = () => controller.togglePause();
  const handleRestart = () => controller.restart();
  const handleRetry = () => {
    void controller.retryResult();
  };
  const handleResize = () => renderer.render(controller.getState());

  startButton.addEventListener('click', handleStart);
  pauseButton.addEventListener('click', handleTogglePause);
  restartButton.addEventListener('click', handleRestart);
  retryButton.addEventListener('click', handleRetry);

  const listensForResize = typeof windowRef?.addEventListener === 'function';

  if (listensForResize) {
    windowRef.addEventListener('resize', handleResize);
  }

  let destroyed = false;

  function destroy() {
    if (destroyed) return;
    destroyed = true;

    startButton.removeEventListener('click', handleStart);
    pauseButton.removeEventListener('click', handleTogglePause);
    restartButton.removeEventListener('click', handleRestart);
    retryButton.removeEventListener('click', handleRetry);

    if (
      listensForResize &&
      typeof windowRef.removeEventListener === 'function'
    ) {
      windowRef.removeEventListener('resize', handleResize);
    }

    inputController.destroy();
    controller.destroy();
  }

  return Object.freeze({ controller, destroy });
}

if (globalThis.document) {
  try {
    initializeGameApp();
  } catch (error) {
    const status = globalThis.document.querySelector?.('#game-status');

    if (status) {
      status.textContent =
        error instanceof Error
          ? error.message
          : '无法启动游戏，请刷新页面后重试。';
    }
  }
}
