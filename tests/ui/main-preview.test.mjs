import assert from 'node:assert/strict';
import test from 'node:test';

import { initializeGameApp } from '../../client/scripts/main.js';

const REQUIRED_IDS = Object.freeze([
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

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
const INTERACTIVE_SELECTOR =
  'button, a[href], summary, [role="button"], [role="link"]';

class FakeEventTarget {
  constructor() {
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listenersForType = this.listeners.get(type) ?? new Set();
    listenersForType.add(listener);
    this.listeners.set(type, listenersForType);
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(eventOrType) {
    const event =
      typeof eventOrType === 'string' ? { type: eventOrType } : eventOrType;

    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener.call(this, event);
    }

    return event;
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeElement extends FakeEventTarget {
  constructor({ id = '', tagName = 'div', parent = null } = {}) {
    super();
    this.id = id;
    this.tagName = tagName.toLowerCase();
    this.parentElement = parent;
    this.dataset = {};
    this.textContent = '';
    this.disabled = false;
    this.hidden = false;
  }

  matches(selector) {
    if (selector === EDITABLE_SELECTOR) {
      return ['input', 'textarea', 'select'].includes(this.tagName);
    }

    if (selector === INTERACTIVE_SELECTOR) {
      return this.tagName === 'button';
    }

    if (selector === '[data-direction]') {
      return Object.hasOwn(this.dataset, 'direction');
    }

    return false;
  }

  closest(selector) {
    let element = this;

    while (element) {
      if (element.matches?.(selector)) return element;
      element = element.parentElement;
    }

    return null;
  }

  contains(candidate) {
    let element = candidate;

    while (element) {
      if (element === this) return true;
      element = element.parentElement;
    }

    return false;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor(elements) {
    super();
    this.elements = elements;
    this.documentElement = { dataset: {} };
    this.hidden = false;
    this.selectors = [];
  }

  querySelector(selector) {
    this.selectors.push(selector);
    return this.elements.get(selector.slice(1)) ?? null;
  }
}

function createFakeContext() {
  const context = {
    calls: [],
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };

  for (const method of [
    'setTransform',
    'fillRect',
    'beginPath',
    'moveTo',
    'lineTo',
    'stroke',
    'arc',
    'fill',
    'save',
    'restore',
    'fillText',
  ]) {
    context[method] = (...args) => {
      context.calls.push({ method, args });
    };
  }

  return context;
}

function createDom({ missingId } = {}) {
  const context = createFakeContext();
  const elements = new Map(
    REQUIRED_IDS.filter((id) => id !== missingId).map((id) => [
      id,
      new FakeElement({
        id,
        tagName:
          id === 'start-game' ||
          id === 'toggle-pause' ||
          id === 'restart-game' ||
          id === 'retry-score'
            ? 'button'
            : 'div',
      }),
    ]),
  );
  const canvas = elements.get('game-canvas');

  if (canvas) {
    canvas.clientWidth = 320;
    canvas.width = 0;
    canvas.height = 0;
    canvas.getBoundingClientRect = () => ({ width: canvas.clientWidth });
    canvas.getContext = (type) => (type === '2d' ? context : null);
  }

  return {
    context,
    elements,
    documentRef: new FakeDocument(elements),
    windowRef: new FakeEventTarget(),
  };
}

function createKeyboardEvent(key) {
  return {
    type: 'keydown',
    key,
    target: new FakeElement(),
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
  };
}

function createSubstituteHarness({ windowRef } = {}) {
  const dom = createDom();
  const effectiveWindow = windowRef ?? dom.windowRef;
  const creationOrder = [];
  const renderedStates = [];
  const turnDirections = [];
  const controllerCalls = {
    starts: 0,
    pauses: 0,
    restarts: 0,
    retries: 0,
    destroys: 0,
    getStates: 0,
  };
  const factoryCalls = {
    renderers: 0,
    scoreStores: 0,
    controllers: 0,
    inputs: 0,
  };
  let state = Object.freeze({ status: 'ready', source: 'controller' });
  let rendererCanvas;
  let controllerOptions;
  let inputOptions;
  let inputDestroyed = false;
  let inputDestroyCalls = 0;
  let rendererResizeCalls = 0;

  const renderer = {
    resize() {
      rendererResizeCalls += 1;
    },
    render(receivedState) {
      renderedStates.push(receivedState);
    },
  };
  const scoreStore = Object.freeze({ source: 'score-store' });
  const controller = Object.freeze({
    start() {
      controllerCalls.starts += 1;
    },
    togglePause() {
      controllerCalls.pauses += 1;
    },
    restart() {
      controllerCalls.restarts += 1;
    },
    turn(direction) {
      turnDirections.push(direction);
    },
    retryResult() {
      controllerCalls.retries += 1;
      return Promise.resolve();
    },
    destroy() {
      controllerCalls.destroys += 1;
    },
    getState() {
      controllerCalls.getStates += 1;
      return state;
    },
  });
  const inputController = Object.freeze({
    destroy() {
      inputDestroyCalls += 1;
      inputDestroyed = true;
    },
  });
  const onGameFinished = () => undefined;

  const app = initializeGameApp({
    documentRef: dom.documentRef,
    windowRef: effectiveWindow,
    createRenderer(canvas) {
      creationOrder.push('renderer');
      factoryCalls.renderers += 1;
      rendererCanvas = canvas;
      return renderer;
    },
    createScoreStore(...args) {
      creationOrder.push('score-store');
      factoryCalls.scoreStores += 1;
      assert.deepEqual(args, []);
      return scoreStore;
    },
    createController(options) {
      creationOrder.push('controller');
      factoryCalls.controllers += 1;
      controllerOptions = options;
      renderer.render(state);
      return controller;
    },
    createInput(options) {
      creationOrder.push('input');
      factoryCalls.inputs += 1;
      inputOptions = options;
      return inputController;
    },
    onGameFinished,
  });

  return {
    ...dom,
    windowRef: effectiveWindow,
    app,
    controller,
    controllerCalls,
    controllerOptions: () => controllerOptions,
    creationOrder,
    factoryCalls,
    input: {
      trigger(name, ...args) {
        if (!inputDestroyed) inputOptions[name](...args);
      },
      destroyCalls() {
        return inputDestroyCalls;
      },
      options() {
        return inputOptions;
      },
    },
    onGameFinished,
    renderedStates,
    renderer,
    rendererCanvas: () => rendererCanvas,
    rendererResizeCalls: () => rendererResizeCalls,
    scoreStore,
    setState(nextState) {
      state = nextState;
    },
    turnDirections,
  };
}

test('查齐 DOM 后按顺序创建依赖并返回最小冻结应用 API', () => {
  const harness = createSubstituteHarness();
  const options = harness.controllerOptions();
  const inputOptions = harness.input.options();

  assert.deepEqual(
    harness.documentRef.selectors,
    REQUIRED_IDS.map((id) => `#${id}`),
  );
  assert.equal(
    harness.documentRef.documentElement.dataset.javascript,
    'enabled',
  );
  assert.deepEqual(harness.creationOrder, [
    'renderer',
    'score-store',
    'controller',
    'input',
  ]);
  assert.deepEqual(harness.factoryCalls, {
    renderers: 1,
    scoreStores: 1,
    controllers: 1,
    inputs: 1,
  });
  assert.strictEqual(
    harness.rendererCanvas(),
    harness.elements.get('game-canvas'),
  );
  assert.deepEqual(Object.keys(options), [
    'elements',
    'renderer',
    'scoreStore',
    'onGameFinished',
  ]);
  assert.deepEqual(Object.keys(options.elements), [
    'currentScore',
    'bestScore',
    'speedLevel',
    'status',
    'startButton',
    'pauseButton',
    'restartButton',
    'retryButton',
  ]);
  assert.strictEqual(
    options.elements.currentScore,
    harness.elements.get('current-score'),
  );
  assert.strictEqual(
    options.elements.bestScore,
    harness.elements.get('best-score'),
  );
  assert.strictEqual(
    options.elements.speedLevel,
    harness.elements.get('speed-level'),
  );
  assert.strictEqual(
    options.elements.status,
    harness.elements.get('game-status'),
  );
  assert.strictEqual(
    options.elements.startButton,
    harness.elements.get('start-game'),
  );
  assert.strictEqual(
    options.elements.pauseButton,
    harness.elements.get('toggle-pause'),
  );
  assert.strictEqual(
    options.elements.restartButton,
    harness.elements.get('restart-game'),
  );
  assert.strictEqual(
    options.elements.retryButton,
    harness.elements.get('retry-score'),
  );
  assert.strictEqual(options.renderer, harness.renderer);
  assert.strictEqual(options.scoreStore, harness.scoreStore);
  assert.strictEqual(options.onGameFinished, harness.onGameFinished);
  assert.strictEqual(inputOptions.documentObject, harness.documentRef);
  assert.strictEqual(inputOptions.touchRoot, harness.elements.get('touch-controls'));
  assert.deepEqual(Object.keys(inputOptions), [
    'documentObject',
    'touchRoot',
    'onDirection',
    'onTogglePause',
    'onRestart',
    'onStart',
    'onPageHidden',
  ]);
  assert.equal(Object.isFrozen(harness.app), true);
  assert.deepEqual(Object.keys(harness.app), ['controller', 'destroy']);
  assert.strictEqual(harness.app.controller, harness.controller);
  assert.equal(harness.renderedStates.length, 1);
  assert.equal(harness.controllerCalls.getStates, 0);
  assert.equal(harness.rendererResizeCalls(), 0);

  harness.app.destroy();
});

test('输入回调、页面隐藏和四个按钮转发到控制器', () => {
  const harness = createSubstituteHarness();

  harness.input.trigger('onDirection', 'up');
  harness.input.trigger('onTogglePause');
  harness.input.trigger('onRestart');
  harness.input.trigger('onStart');

  assert.deepEqual(harness.turnDirections, ['up']);
  assert.equal(harness.controllerCalls.pauses, 1);
  assert.equal(harness.controllerCalls.restarts, 1);
  assert.equal(harness.controllerCalls.starts, 1);

  for (const status of ['ready', 'paused', 'game-over', 'won']) {
    harness.setState({ status });
    harness.input.trigger('onPageHidden');
  }
  assert.equal(harness.controllerCalls.pauses, 1);

  harness.setState({ status: 'running' });
  harness.input.trigger('onPageHidden');
  assert.equal(harness.controllerCalls.pauses, 2);

  harness.elements.get('start-game').dispatch('click');
  harness.elements.get('toggle-pause').dispatch('click');
  harness.elements.get('restart-game').dispatch('click');
  harness.elements.get('retry-score').dispatch('click');

  assert.equal(harness.controllerCalls.starts, 2);
  assert.equal(harness.controllerCalls.pauses, 3);
  assert.equal(harness.controllerCalls.restarts, 2);
  assert.equal(harness.controllerCalls.retries, 1);

  harness.app.destroy();
});

test('窗口缩放时只用控制器当前状态重绘', () => {
  const harness = createSubstituteHarness();
  const currentState = Object.freeze({ status: 'paused', version: 2 });

  harness.renderedStates.length = 0;
  harness.setState(currentState);
  harness.windowRef.dispatch('resize');

  assert.deepEqual(harness.renderedStates, [currentState]);
  assert.equal(harness.controllerCalls.getStates, 1);
  assert.equal(harness.rendererResizeCalls(), 0);

  harness.app.destroy();
});

test('窗口不支持事件监听时仍可初始化和幂等销毁', () => {
  const harness = createSubstituteHarness({ windowRef: {} });

  assert.doesNotThrow(() => {
    harness.app.destroy();
    harness.app.destroy();
  });
  assert.equal(harness.input.destroyCalls(), 1);
  assert.equal(harness.controllerCalls.destroys, 1);
});

test('重复销毁只清理一次且外部事件和输入不再生效', () => {
  const harness = createSubstituteHarness();
  const buttonIds = [
    'start-game',
    'toggle-pause',
    'restart-game',
    'retry-score',
  ];

  assert.equal(harness.windowRef.listenerCount('resize'), 1);
  for (const id of buttonIds) {
    assert.equal(harness.elements.get(id).listenerCount('click'), 1);
  }

  harness.app.destroy();
  harness.app.destroy();

  assert.equal(harness.windowRef.listenerCount('resize'), 0);
  for (const id of buttonIds) {
    assert.equal(harness.elements.get(id).listenerCount('click'), 0);
    harness.elements.get(id).dispatch('click');
  }
  harness.windowRef.dispatch('resize');
  harness.input.trigger('onDirection', 'left');
  harness.input.trigger('onTogglePause');
  harness.input.trigger('onRestart');
  harness.input.trigger('onStart');
  harness.input.trigger('onPageHidden');

  assert.equal(harness.input.destroyCalls(), 1);
  assert.equal(harness.controllerCalls.destroys, 1);
  assert.deepEqual(harness.turnDirections, []);
  assert.deepEqual(harness.controllerCalls, {
    starts: 0,
    pauses: 0,
    restarts: 0,
    retries: 0,
    destroys: 1,
    getStates: 0,
  });
  assert.equal(harness.renderedStates.length, 1);
});

for (const [missingIndex, missingId] of REQUIRED_IDS.entries()) {
  test(`缺少 #${missingId} 时不创建任何依赖`, () => {
    const { documentRef, windowRef } = createDom({ missingId });
    const factoryCalls = {
      renderers: 0,
      scoreStores: 0,
      controllers: 0,
      inputs: 0,
    };

    assert.throws(
      () =>
        initializeGameApp({
          documentRef,
          windowRef,
          createRenderer() {
            factoryCalls.renderers += 1;
          },
          createScoreStore() {
            factoryCalls.scoreStores += 1;
          },
          createController() {
            factoryCalls.controllers += 1;
          },
          createInput() {
            factoryCalls.inputs += 1;
          },
        }),
      { message: `找不到 #${missingId}，无法启动游戏。` },
    );
    assert.deepEqual(factoryCalls, {
      renderers: 0,
      scoreStores: 0,
      controllers: 0,
      inputs: 0,
    });
    assert.deepEqual(
      documentRef.selectors,
      REQUIRED_IDS.slice(0, missingIndex + 1).map((id) => `#${id}`),
    );
  });
}

test('默认真实模块可开始、转向、页面隐藏暂停并完整清理', () => {
  const { context, documentRef, elements, windowRef } = createDom();
  const originalLocalStorage = Object.getOwnPropertyDescriptor(
    globalThis,
    'localStorage',
  );
  const storageCalls = [];
  const fakeStorage = {
    getItem(key) {
      storageCalls.push({ method: 'getItem', key });
      return '40';
    },
    setItem(key, value) {
      storageCalls.push({ method: 'setItem', key, value });
    },
  };
  let app;

  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: fakeStorage,
  });

  try {
    app = initializeGameApp({ documentRef, windowRef });

    assert.equal(app.controller.getState().status, 'ready');
    assert.equal(elements.get('current-score').textContent, '0');
    assert.equal(elements.get('best-score').textContent, '40');
    assert.equal(elements.get('speed-level').textContent, '1');
    assert.ok(elements.get('game-canvas').width > 0);
    assert.equal(
      context.calls.some(({ method }) => method === 'fillText'),
      true,
    );
    assert.deepEqual(storageCalls, [
      {
        method: 'getItem',
        key: 'docker-snake.guest-best-score.v1',
      },
    ]);

    elements.get('start-game').dispatch('click');
    assert.equal(app.controller.getState().status, 'running');

    const keyEvent = documentRef.dispatch(createKeyboardEvent('ArrowUp'));
    assert.equal(keyEvent.defaultPrevented, true);
    assert.equal(app.controller.getState().direction, 'up');

    documentRef.hidden = true;
    documentRef.dispatch('visibilitychange');
    assert.equal(app.controller.getState().status, 'paused');

    app.destroy();

    assert.equal(documentRef.listenerCount('keydown'), 0);
    assert.equal(documentRef.listenerCount('visibilitychange'), 0);
    assert.equal(
      elements.get('touch-controls').listenerCount('pointerdown'),
      0,
    );
    assert.equal(windowRef.listenerCount('resize'), 0);
    for (const id of [
      'start-game',
      'toggle-pause',
      'restart-game',
      'retry-score',
    ]) {
      assert.equal(elements.get(id).listenerCount('click'), 0);
    }
  } finally {
    app?.destroy();

    if (originalLocalStorage) {
      Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
      delete globalThis.localStorage;
    }
  }
});
