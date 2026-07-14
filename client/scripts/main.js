import { createApiClient } from './api.js';
import { createAuthController } from './auth.js';
import { createCanvasRenderer } from './canvas-renderer.js';
import { createGameController } from './game-ui.js';
import { createGuestScoreStore } from './guest-score.js';
import { createInputController } from './input-controller.js';
import { createLeaderboardController } from './leaderboard.js';
import { createScoreCoordinator } from './score-coordinator.js';

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
    initialBestScore,
    onRoundStarted,
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
  const usesExternalScoreSource = initialBestScore !== undefined
    || typeof onRoundStarted === 'function';
  const controllerElements = {
    currentScore: requiredElements['current-score'],
    bestScore: requiredElements['best-score'],
    speedLevel: requiredElements['speed-level'],
    status: requiredElements['game-status'],
    startButton: requiredElements['start-game'],
    pauseButton: requiredElements['toggle-pause'],
    restartButton: requiredElements['restart-game'],
    retryButton: requiredElements['retry-score'],
  };
  let controllerOptions;
  if (usesExternalScoreSource) {
    controllerOptions = {
      elements: controllerElements,
      renderer,
      initialBestScore: initialBestScore ?? 0,
      onRoundStarted,
      onGameFinished,
    };
  } else {
    controllerOptions = {
      elements: controllerElements,
      renderer,
      scoreStore: createScoreStore(),
      onGameFinished,
    };
  }
  const controller = createController(controllerOptions);
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

const AUTH_ELEMENT_IDS = Object.freeze({
  sessionStatus: 'session-status',
  showRegisterButton: 'show-register',
  showLoginButton: 'show-login',
  logoutButton: 'logout-account',
  panel: 'auth-panel',
  title: 'auth-title',
  form: 'auth-form',
  usernameInput: 'auth-username',
  passwordInput: 'auth-password',
  confirmRow: 'confirm-row',
  confirmPasswordInput: 'confirm-password',
  help: 'auth-help',
  message: 'auth-message',
  submitButton: 'auth-submit',
  cancelButton: 'auth-cancel',
});

const LEADERBOARD_ELEMENT_IDS = Object.freeze({
  status: 'leaderboard-status',
  list: 'leaderboard-list',
  myRank: 'my-rank',
  refreshButton: 'refresh-leaderboard',
});

function collectElements(documentRef, idMap) {
  const elements = {};
  for (const [key, id] of Object.entries(idMap)) {
    const element = documentRef?.querySelector?.(`#${id}`);
    if (!element) throw new Error(`找不到 #${id}，无法启动网页应用。`);
    elements[key] = element;
  }
  return elements;
}

export async function initializeBrowserApp({
  documentRef = globalThis.document,
  windowRef = globalThis.window,
  createApi = createApiClient,
  createGuestStore = createGuestScoreStore,
  createAuth = createAuthController,
  createScoreSync = createScoreCoordinator,
  createLeaderboard = createLeaderboardController,
  initializeGame = initializeGameApp,
} = {}) {
  const authElements = collectElements(documentRef, AUTH_ELEMENT_IDS);
  const leaderboardElements = collectElements(documentRef, LEADERBOARD_ELEMENT_IDS);
  const api = createApi();
  const guestScoreStore = createGuestStore();
  const auth = createAuth({ api, elements: authElements });
  let game = null;
  let leaderboard = null;
  let scoreSync = null;
  let unsubscribe = () => undefined;

  try {
    await auth.initialize();
    scoreSync = createScoreSync({
      api,
      guestScoreStore,
      getAuthSnapshot: auth.getSnapshot,
      onBestScore(score) {
        game?.controller.setBestScore(score);
      },
      onScoreSubmitted() {
        void leaderboard?.refresh();
      },
      onAuthenticationRequired() {
        void auth.initialize();
      },
    });

    const initialSnapshot = auth.getSnapshot();
    const initialBestScore = initialSnapshot.status === 'guest'
      ? guestScoreStore.getBestScore()
      : 0;
    game = initializeGame({
      documentRef,
      windowRef,
      initialBestScore,
      onRoundStarted: scoreSync.beginRound,
      onGameFinished: scoreSync.finishRound,
    });
    leaderboard = createLeaderboard({
      api,
      elements: leaderboardElements,
      documentRef,
      getAuthSnapshot: auth.getSnapshot,
      onServerBest: scoreSync.applyServerBest,
    });
    unsubscribe = auth.subscribe((snapshot) => {
      scoreSync.handleAuthChange(snapshot);
      leaderboard.handleAuthChange(snapshot);
    });
  } catch (error) {
    unsubscribe();
    leaderboard?.destroy();
    scoreSync?.destroy();
    game?.destroy();
    auth.destroy();
    throw error;
  }

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    unsubscribe();
    leaderboard.destroy();
    scoreSync.destroy();
    game.destroy();
    auth.destroy();
  }

  return Object.freeze({ auth, game, leaderboard, destroy });
}

if (globalThis.document) {
  initializeBrowserApp().catch((error) => {
    const status = globalThis.document.querySelector?.('#game-status');

    if (status) {
      status.textContent =
        error instanceof Error
          ? error.message
          : '无法启动游戏，请刷新页面后重试。';
    }
  });
}
