import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createCanvasRenderer } from '../../client/scripts/canvas-renderer.js';

function createFakeContext() {
  const calls = [];
  const context = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
  };

  function record(method, args) {
    calls.push({
      method,
      args: [...args],
      fillStyle: context.fillStyle,
      strokeStyle: context.strokeStyle,
    });
  }

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
    context[method] = (...args) => record(method, args);
  }

  return { context, calls };
}

function createFakeCanvas(context) {
  return {
    width: 0,
    height: 0,
    clientWidth: 400,
    getBoundingClientRect() {
      return { width: this.clientWidth };
    },
    getContext(type) {
      return type === '2d' ? context : null;
    },
  };
}

function createState(overrides = {}) {
  return {
    boardSize: 20,
    snake: [
      { x: 9, y: 10 },
      { x: 8, y: 10 },
      { x: 7, y: 10 },
      { x: 6, y: 10 },
    ],
    food: { x: 3, y: 4 },
    status: 'running',
    ...overrides,
  };
}

describe('Canvas 尺寸与像素密度', () => {
  test('创建冻结渲染器并按显示宽度和 DPR 调整画布', () => {
    const { context, calls } = createFakeContext();
    const canvas = createFakeCanvas(context);
    const renderer = createCanvasRenderer(canvas, {
      getDisplaySize: () => 400,
      getPixelRatio: () => 2,
    });

    renderer.resize();

    assert.equal(Object.isFrozen(renderer), true);
    assert.equal(canvas.width, 800);
    assert.equal(canvas.height, 800);
    assert.deepEqual(
      calls.find((call) => call.method === 'setTransform').args,
      [2, 0, 0, 2, 0, 0],
    );
  });

  test('DPR 安全限制在一到二之间', () => {
    const low = createFakeContext();
    const lowCanvas = createFakeCanvas(low.context);
    const lowRenderer = createCanvasRenderer(lowCanvas, {
      getDisplaySize: () => 400,
      getPixelRatio: () => 0.25,
    });

    lowRenderer.resize();
    assert.equal(lowCanvas.width, 400);
    assert.deepEqual(
      low.calls.find((call) => call.method === 'setTransform').args,
      [1, 0, 0, 1, 0, 0],
    );

    const high = createFakeContext();
    const highCanvas = createFakeCanvas(high.context);
    const highRenderer = createCanvasRenderer(highCanvas, {
      getDisplaySize: () => 400,
      getPixelRatio: () => 5,
    });

    highRenderer.resize();
    assert.equal(highCanvas.width, 800);
    assert.deepEqual(
      high.calls.find((call) => call.method === 'setTransform').args,
      [2, 0, 0, 2, 0, 0],
    );
  });

  test('render 会在绘制前自动调整尺寸', () => {
    const { context, calls } = createFakeContext();
    const canvas = createFakeCanvas(context);
    const renderer = createCanvasRenderer(canvas, {
      getDisplaySize: () => 320,
      getPixelRatio: () => 1.5,
    });

    renderer.render(createState());

    assert.equal(canvas.width, 480);
    assert.equal(canvas.height, 480);
    assert.ok(calls.some((call) => call.method === 'setTransform'));
  });
});

describe('游戏状态绘制', () => {
  test('绘制背景、二十格网格、蛇头、蛇身和食物', () => {
    const { context, calls } = createFakeContext();
    const canvas = createFakeCanvas(context);
    const renderer = createCanvasRenderer(canvas, {
      getDisplaySize: () => 400,
      getPixelRatio: () => 1,
    });

    renderer.render(createState());

    assert.ok(
      calls.some(
        (call) =>
          call.method === 'fillRect' &&
          call.fillStyle === '#020503' &&
          call.args[2] === 400 &&
          call.args[3] === 400,
      ),
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'stroke' &&
          call.strokeStyle === 'rgba(85,255,138,0.10)',
      ),
    );
    assert.ok(
      calls.filter((call) => call.method === 'lineTo').length >= 40,
      '网格应包含横向和纵向分隔线',
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'fillRect' && call.fillStyle === '#b5ffc9',
      ),
      '应绘制不同颜色的蛇头',
    );
    assert.ok(
      calls.some(
        (call) =>
          call.method === 'fillRect' && call.fillStyle === '#55ff8a',
      ),
      '应绘制蛇身',
    );
    assert.ok(calls.some((call) => call.method === 'arc'));
    assert.ok(
      calls.some(
        (call) => call.method === 'fill' && call.fillStyle === '#ff4f87',
      ),
      '应绘制食物',
    );
  });

  test('为 ready、paused、game-over 和 won 绘制中文提示', () => {
    const overlays = new Map([
      ['ready', '按开始游戏'],
      ['paused', '游戏已暂停'],
      ['game-over', '游戏结束'],
      ['won', '棋盘已占满，你赢了！'],
    ]);

    for (const [status, message] of overlays) {
      const { context, calls } = createFakeContext();
      const renderer = createCanvasRenderer(createFakeCanvas(context), {
        getDisplaySize: () => 400,
        getPixelRatio: () => 1,
      });

      renderer.render(createState({ status }));

      assert.ok(
        calls.some(
          (call) =>
            call.method === 'fillText' &&
            call.args[0] === message &&
            call.fillStyle === '#d7ffe2',
        ),
        status + ' 应显示对应中文提示',
      );
    }
  });

  test('running 状态不绘制覆盖提示', () => {
    const { context, calls } = createFakeContext();
    const renderer = createCanvasRenderer(createFakeCanvas(context), {
      getDisplaySize: () => 400,
      getPixelRatio: () => 1,
    });

    renderer.render(createState({ status: 'running' }));

    assert.equal(calls.some((call) => call.method === 'fillText'), false);
  });

  test('render 不修改状态且 food 为 null 时不画圆', () => {
    const { context, calls } = createFakeContext();
    const renderer = createCanvasRenderer(createFakeCanvas(context), {
      getDisplaySize: () => 400,
      getPixelRatio: () => 1,
    });
    const state = createState({ food: null });
    const before = JSON.parse(JSON.stringify(state));

    renderer.render(state);

    assert.deepEqual(state, before);
    assert.equal(calls.some((call) => call.method === 'arc'), false);
  });
});

test('缺少 Canvas 2D 上下文时抛出中文错误', () => {
  const canvas = {
    getContext() {
      return null;
    },
  };

  assert.throws(
    () => createCanvasRenderer(canvas),
    /浏览器不支持 Canvas 2D，无法启动游戏。/,
  );
});
