import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const cssPath = new URL('../../client/styles/main.css', import.meta.url);
const htmlPath = new URL('../../client/index.html', import.meta.url);

async function readAssets() {
  const [css, html] = await Promise.all([
    readFile(cssPath, 'utf8'),
    readFile(htmlPath, 'utf8'),
  ]);

  return { css, html };
}

function declarationBlock(css, selector) {
  const escapedSelector = selector.replace(/[.*+?^$(){}|[\]\\]/g, '\\$&');
  const match = css.match(
    new RegExp(escapedSelector + '\\s*\\{([^}]*)\\}', 'i'),
  );

  assert.ok(match, '缺少 ' + selector + ' 样式规则');
  return match[1];
}

function mediaBlock(css, condition) {
  const header = new RegExp(
    '@media\\s*\\(\\s*' + condition + '\\s*\\)\\s*\\{',
    'i',
  ).exec(css);

  assert.ok(header, '缺少 @media (' + condition + ')');

  const openingBrace = header.index + header[0].lastIndexOf('{');
  let depth = 0;

  for (let index = openingBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(openingBrace + 1, index);
  }

  assert.fail('@media (' + condition + ') 缺少结束花括号');
}

test('在 CSS 变量中声明终端霓虹配色', async () => {
  const { css } = await readAssets();
  const root = declarationBlock(css, ':root');

  for (const color of ['#050806', '#55ff8a', '#ff4f87']) {
    assert.match(
      root,
      new RegExp('--[\\w-]+\\s*:\\s*' + color + '\\b', 'i'),
      '缺少颜色变量 ' + color,
    );
  }
});

test('页面不会横向溢出且画布保持响应式正方形', async () => {
  const { css } = await readAssets();
  const body = declarationBlock(css, 'body');
  const frame = declarationBlock(css, '.canvas-frame');
  const canvas = declarationBlock(css, '#game-canvas');

  assert.match(body, /\boverflow-x\s*:\s*hidden\s*;/i);
  assert.match(frame, /\baspect-ratio\s*:\s*(?:1|1\s*\/\s*1)\s*;/i);
  assert.match(canvas, /\bwidth\s*:\s*100%\s*;/i);
  assert.match(canvas, /\bheight\s*:\s*100%\s*;/i);
});

test('提供键盘焦点、隐藏元素与减少动态效果的样式', async () => {
  const { css } = await readAssets();
  const hidden = declarationBlock(css, '[hidden]');
  const reducedMotion = mediaBlock(
    css,
    'prefers-reduced-motion\\s*:\\s*reduce',
  );

  assert.match(css, /:focus-visible[^{]*\{/i);
  assert.match(hidden, /\bdisplay\s*:\s*none\s*!important\s*;/i);
  assert.match(
    reducedMotion,
    /(?:animation|transition)(?:-duration)?\s*:/i,
  );
});

test('触控方向键默认隐藏并在窄屏或粗指针设备显示', async () => {
  const { css } = await readAssets();
  const defaultTouchControls = declarationBlock(css, '.touch-controls');
  const narrowScreen = mediaBlock(css, 'max-width\\s*:\\s*720px');
  const coarsePointer = mediaBlock(css, 'pointer\\s*:\\s*coarse');

  assert.match(defaultTouchControls, /\bdisplay\s*:\s*none\s*;/i);
  assert.match(
    declarationBlock(narrowScreen, '.touch-controls'),
    /\bdisplay\s*:\s*grid\s*;/i,
  );
  assert.match(
    declarationBlock(coarsePointer, '.touch-controls'),
    /\bdisplay\s*:\s*grid\s*;/i,
  );
});

test('HTML 提供响应式控制台所需的结构类名', async () => {
  const { html } = await readAssets();
  const classNames = new Set(
    [...html.matchAll(/\bclass=["']([^"']*)["']/gi)].flatMap((match) =>
      match[1].trim().split(/\s+/),
    ),
  );
  const requiredClassNames = [
    'page-shell',
    'topbar',
    'game-console',
    'metrics',
    'metric',
    'canvas-frame',
    'game-status',
    'game-actions',
    'instructions',
    'touch-controls',
    'leaderboard',
  ];

  for (const className of requiredClassNames) {
    assert.ok(classNames.has(className), '缺少 .' + className);
  }
});
