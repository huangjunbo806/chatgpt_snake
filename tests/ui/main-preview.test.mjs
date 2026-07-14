import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeGamePreview } from '../../client/scripts/main.js';

function createFakeWindow() {
  const listeners = new Map();

  return {
    addEventListener(type, listener) {
      const typeListeners = listeners.get(type) ?? new Set();
      typeListeners.add(listener);
      listeners.set(type, typeListeners);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    dispatch(type) {
      for (const listener of listeners.get(type) ?? []) listener();
    },
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}

test('初始化静态预览并在窗口缩放时重绘同一初始状态', () => {
  const canvas = { id: 'game-canvas' };
  const selectors = [];
  const documentRef = {
    documentElement: { dataset: {} },
    querySelector(selector) {
      selectors.push(selector);
      return selector === '#game-canvas' ? canvas : null;
    },
  };
  const windowRef = createFakeWindow();
  const state = Object.freeze({ status: 'ready' });
  const renderedStates = [];
  let createStateCalls = 0;
  let createRendererCalls = 0;
  let resizeCalls = 0;

  const createState = () => {
    createStateCalls += 1;
    return state;
  };
  const createRenderer = (receivedCanvas) => {
    createRendererCalls += 1;
    assert.strictEqual(receivedCanvas, canvas);

    return {
      resize() {
        resizeCalls += 1;
      },
      render(receivedState) {
        renderedStates.push(receivedState);
      },
    };
  };

  const preview = initializeGamePreview({
    documentRef,
    windowRef,
    createState,
    createRenderer,
  });

  assert.deepEqual(selectors, ['#game-canvas']);
  assert.equal(documentRef.documentElement.dataset.javascript, 'enabled');
  assert.equal(createStateCalls, 1);
  assert.equal(createRendererCalls, 1);
  assert.equal(resizeCalls, 1);
  assert.deepEqual(renderedStates, [state]);
  assert.strictEqual(preview.state, state);
  assert.equal(windowRef.listenerCount('resize'), 1);

  windowRef.dispatch('resize');

  assert.equal(createStateCalls, 1);
  assert.equal(createRendererCalls, 1);
  assert.equal(resizeCalls, 2);
  assert.deepEqual(renderedStates, [state, state]);

  preview.destroy();
  assert.equal(windowRef.listenerCount('resize'), 0);

  windowRef.dispatch('resize');
  assert.equal(resizeCalls, 2);
  assert.deepEqual(renderedStates, [state, state]);
});

test('缺少游戏画布时给出清晰错误且不创建状态或渲染器', () => {
  let createStateCalls = 0;
  let createRendererCalls = 0;
  const documentRef = {
    documentElement: { dataset: {} },
    querySelector() {
      return null;
    },
  };

  assert.throws(
    () =>
      initializeGamePreview({
        documentRef,
        windowRef: createFakeWindow(),
        createState() {
          createStateCalls += 1;
        },
        createRenderer() {
          createRendererCalls += 1;
        },
      }),
    /找不到 #game-canvas，无法显示游戏初始画面。/,
  );
  assert.equal(createStateCalls, 0);
  assert.equal(createRendererCalls, 0);
});
