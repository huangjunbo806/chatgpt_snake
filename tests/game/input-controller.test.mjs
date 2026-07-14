import assert from 'node:assert/strict';
import test from 'node:test';

import { createInputController } from '../../client/scripts/input-controller.js';

const EDITABLE_SELECTOR =
  'input, textarea, select, [contenteditable]:not([contenteditable="false"])';

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

  dispatch(event) {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      listener.call(this, event);
    }

    return event;
  }
}

class FakeDocument extends FakeEventTarget {
  constructor() {
    super();
    this.hidden = false;
  }
}

class FakeElement extends FakeEventTarget {
  constructor({
    tagName = 'div',
    contenteditable,
    direction,
    parent = null,
  } = {}) {
    super();
    this.tagName = tagName.toLowerCase();
    this.parentElement = parent;
    this.dataset = {};

    if (contenteditable !== undefined) {
      this.contenteditable = contenteditable;
    }
    if (direction !== undefined) this.dataset.direction = direction;
  }

  matches(selector) {
    if (selector === EDITABLE_SELECTOR) {
      return (
        ['input', 'textarea', 'select'].includes(this.tagName) ||
        (this.contenteditable !== undefined &&
          this.contenteditable !== 'false')
      );
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

function createKeyboardEvent(key, options = {}) {
  return {
    type: 'keydown',
    key,
    target: new FakeElement(),
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    defaultPrevented: false,
    preventDefaultCalls: 0,
    ...options,
    preventDefault() {
      this.defaultPrevented = true;
      this.preventDefaultCalls += 1;
    },
  };
}

function createPointerEvent(target) {
  return {
    type: 'pointerdown',
    target,
    defaultPrevented: false,
    preventDefaultCalls: 0,
    preventDefault() {
      this.defaultPrevented = true;
      this.preventDefaultCalls += 1;
    },
  };
}

function createHarness() {
  const documentObject = new FakeDocument();
  const touchRoot = new FakeElement();
  const calls = {
    directions: [],
    pauses: 0,
    restarts: 0,
    starts: 0,
    pageHidden: 0,
  };
  const controller = createInputController({
    documentObject,
    touchRoot,
    onDirection(direction) {
      calls.directions.push(direction);
    },
    onTogglePause() {
      calls.pauses += 1;
    },
    onRestart() {
      calls.restarts += 1;
    },
    onStart() {
      calls.starts += 1;
    },
    onPageHidden() {
      calls.pageHidden += 1;
    },
  });

  return { documentObject, touchRoot, calls, controller };
}

test('方向键和大小写 WASD 映射为四个统一方向', () => {
  const { documentObject, calls } = createHarness();
  const cases = [
    ['ArrowUp', 'up'],
    ['ArrowDown', 'down'],
    ['ArrowLeft', 'left'],
    ['ArrowRight', 'right'],
    ['w', 'up'],
    ['W', 'up'],
    ['s', 'down'],
    ['S', 'down'],
    ['a', 'left'],
    ['A', 'left'],
    ['d', 'right'],
    ['D', 'right'],
  ];

  for (const [key, direction] of cases) {
    const event = documentObject.dispatch(createKeyboardEvent(key));
    assert.equal(event.defaultPrevented, true, `${key} 应阻止默认行为`);
    assert.equal(event.preventDefaultCalls, 1);
    assert.equal(calls.directions.at(-1), direction);
  }

  assert.deepEqual(
    calls.directions,
    cases.map(([, direction]) => direction),
  );
});

test('空格和 P 切换暂停、R 重开、Enter 开始且只拦截已识别键', () => {
  const { documentObject, calls } = createHarness();

  for (const key of [' ', 'p', 'P']) {
    const event = documentObject.dispatch(createKeyboardEvent(key));
    assert.equal(event.defaultPrevented, true);
  }
  for (const key of ['r', 'R']) {
    const event = documentObject.dispatch(createKeyboardEvent(key));
    assert.equal(event.defaultPrevented, true);
  }

  const enterEvent = documentObject.dispatch(createKeyboardEvent('Enter'));
  const unknownEvent = documentObject.dispatch(createKeyboardEvent('Escape'));
  const prototypeKeyEvent = documentObject.dispatch(
    createKeyboardEvent('toString'),
  );

  assert.equal(enterEvent.defaultPrevented, true);
  assert.equal(unknownEvent.defaultPrevented, false);
  assert.equal(unknownEvent.preventDefaultCalls, 0);
  assert.equal(prototypeKeyEvent.defaultPrevented, false);
  assert.equal(prototypeKeyEvent.preventDefaultCalls, 0);
  assert.deepEqual(calls, {
    directions: [],
    pauses: 3,
    restarts: 2,
    starts: 1,
    pageHidden: 0,
  });
});

test('编辑控件、可编辑区域及其后代不触发快捷键', () => {
  const { documentObject, calls } = createHarness();
  const editableParent = new FakeElement({ contenteditable: 'true' });
  const inputParent = new FakeElement({ tagName: 'input' });
  const editableTargets = [
    new FakeElement({ tagName: 'input' }),
    new FakeElement({ tagName: 'textarea' }),
    new FakeElement({ tagName: 'select' }),
    new FakeElement({ contenteditable: '' }),
    new FakeElement({ parent: editableParent }),
    new FakeElement({ parent: inputParent }),
  ];

  for (const target of editableTargets) {
    const event = documentObject.dispatch(
      createKeyboardEvent('ArrowUp', { target }),
    );
    assert.equal(event.defaultPrevented, false);
  }

  assert.deepEqual(calls.directions, []);

  const explicitlyNotEditable = new FakeElement({
    contenteditable: 'false',
  });
  const allowedEvent = documentObject.dispatch(
    createKeyboardEvent('ArrowUp', { target: explicitlyNotEditable }),
  );

  assert.equal(allowedEvent.defaultPrevented, true);
  assert.deepEqual(calls.directions, ['up']);
});

test('输入法合成及 Ctrl、Meta、Alt 组合键不触发动作', () => {
  const { documentObject, calls } = createHarness();

  for (const options of [
    { isComposing: true },
    { ctrlKey: true },
    { metaKey: true },
    { altKey: true },
  ]) {
    const event = documentObject.dispatch(
      createKeyboardEvent('ArrowRight', options),
    );
    assert.equal(event.defaultPrevented, false);
  }

  const shiftedDirection = documentObject.dispatch(
    createKeyboardEvent('W', { shiftKey: true }),
  );

  assert.equal(shiftedDirection.defaultPrevented, true);
  assert.deepEqual(calls.directions, ['up']);
  assert.equal(calls.pauses, 0);
  assert.equal(calls.restarts, 0);
  assert.equal(calls.starts, 0);
});

test('方向键允许持续触发而暂停、重开和开始忽略重复事件', () => {
  const { documentObject, calls } = createHarness();
  const directionEvent = documentObject.dispatch(
    createKeyboardEvent('ArrowLeft', { repeat: true }),
  );

  assert.equal(directionEvent.defaultPrevented, true);
  assert.deepEqual(calls.directions, ['left']);

  for (const key of [' ', 'p', 'P', 'r', 'R', 'Enter']) {
    const event = documentObject.dispatch(
      createKeyboardEvent(key, { repeat: true }),
    );
    assert.equal(event.defaultPrevented, false, `${key} 重复时不应被处理`);
  }

  assert.equal(calls.pauses, 0);
  assert.equal(calls.restarts, 0);
  assert.equal(calls.starts, 0);
});

test('触控委托只处理根节点内带合法方向的数据元素', () => {
  const { touchRoot, calls } = createHarness();
  const leftButton = new FakeElement({
    tagName: 'button',
    direction: 'left',
    parent: touchRoot,
  });
  const icon = new FakeElement({ parent: leftButton });
  const directButton = new FakeElement({
    tagName: 'button',
    direction: 'down',
    parent: touchRoot,
  });

  const delegatedEvent = touchRoot.dispatch(createPointerEvent(icon));
  const directEvent = touchRoot.dispatch(createPointerEvent(directButton));

  assert.equal(delegatedEvent.defaultPrevented, true);
  assert.equal(directEvent.defaultPrevented, true);
  assert.deepEqual(calls.directions, ['left', 'down']);

  const outsideRoot = new FakeElement();
  const outsideButton = new FakeElement({
    tagName: 'button',
    direction: 'up',
    parent: outsideRoot,
  });
  const invalidButton = new FakeElement({
    tagName: 'button',
    direction: 'diagonal',
    parent: touchRoot,
  });

  for (const target of [outsideButton, invalidButton, touchRoot]) {
    const event = touchRoot.dispatch(createPointerEvent(target));
    assert.equal(event.defaultPrevented, false);
    assert.equal(event.preventDefaultCalls, 0);
  }

  assert.deepEqual(calls.directions, ['left', 'down']);
});

test('页面仅在变为隐藏状态时发出通知', () => {
  const { documentObject, calls } = createHarness();

  documentObject.hidden = false;
  documentObject.dispatch({ type: 'visibilitychange' });
  assert.equal(calls.pageHidden, 0);

  documentObject.hidden = true;
  documentObject.dispatch({ type: 'visibilitychange' });
  assert.equal(calls.pageHidden, 1);

  documentObject.hidden = false;
  documentObject.dispatch({ type: 'visibilitychange' });
  assert.equal(calls.pageHidden, 1);
});

test('返回冻结控制器且重复销毁后所有输入均无响应', () => {
  const { documentObject, touchRoot, calls, controller } = createHarness();
  const touchButton = new FakeElement({
    tagName: 'button',
    direction: 'right',
    parent: touchRoot,
  });

  assert.equal(Object.isFrozen(controller), true);
  assert.doesNotThrow(() => {
    controller.destroy();
    controller.destroy();
  });

  const keyEvent = documentObject.dispatch(createKeyboardEvent('ArrowUp'));
  const touchEvent = touchRoot.dispatch(createPointerEvent(touchButton));
  documentObject.hidden = true;
  documentObject.dispatch({ type: 'visibilitychange' });

  assert.equal(keyEvent.defaultPrevented, false);
  assert.equal(touchEvent.defaultPrevented, false);
  assert.deepEqual(calls, {
    directions: [],
    pauses: 0,
    restarts: 0,
    starts: 0,
    pageHidden: 0,
  });
});

test('缺少 document 或触控根节点时抛出清晰中文错误', () => {
  assert.throws(
    () =>
      createInputController({
        documentObject: null,
        touchRoot: new FakeElement(),
      }),
    /缺少 document，无法创建输入控制器。/,
  );
  assert.throws(
    () =>
      createInputController({
        documentObject: new FakeDocument(),
        touchRoot: null,
      }),
    /缺少触控区域 touchRoot，无法创建输入控制器。/,
  );
});
