import { createCanvasRenderer } from './canvas-renderer.js';
import { createInitialState } from './game-engine.js';

export function initializeGamePreview(
  {
    documentRef = globalThis.document,
    windowRef = globalThis.window,
    createState = createInitialState,
    createRenderer = createCanvasRenderer,
  } = {},
) {
  const canvas = documentRef?.querySelector?.('#game-canvas');

  if (!canvas) {
    throw new Error('找不到 #game-canvas，无法显示游戏初始画面。');
  }

  documentRef.documentElement.dataset.javascript = 'enabled';

  const state = createState();
  const renderer = createRenderer(canvas);

  function draw() {
    renderer.resize();
    renderer.render(state);
  }

  draw();

  const listensForResize = typeof windowRef?.addEventListener === 'function';

  if (listensForResize) windowRef.addEventListener('resize', draw);

  function destroy() {
    if (listensForResize && typeof windowRef.removeEventListener === 'function') {
      windowRef.removeEventListener('resize', draw);
    }
  }

  return Object.freeze({ state, renderer, draw, destroy });
}

if (globalThis.document) {
  try {
    initializeGamePreview();
  } catch (error) {
    const status = globalThis.document.querySelector?.('#game-status');

    if (status) {
      status.textContent =
        error instanceof Error
          ? error.message
          : '无法显示游戏初始画面，请刷新页面后重试。';
    }
  }
}
