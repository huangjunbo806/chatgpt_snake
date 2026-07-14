import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pagePath = new URL('../../client/index.html', import.meta.url);

async function readPage() {
  return readFile(pagePath, 'utf8');
}

function visibleText(html) {
  return html
    .replace(/<(?:script|style)\b[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function openingTagWithId(tagName, id) {
  return new RegExp(
    `<${tagName}\\b(?=[^>]*\\bid=["']${id}["'])[^>]*>`,
    'i',
  );
}

test('声明中文 HTML 文档并使用语义化页面区域', async () => {
  const html = await readPage();

  assert.match(html, /^\s*<!doctype html>/i);
  assert.match(html, /<html\b(?=[^>]*\blang=["']zh-CN["'])[^>]*>/i);
  assert.match(html, /<header\b[^>]*>/i);
  assert.match(html, /<main\b[^>]*>/i);
  assert.match(html, /<section\b[^>]*>/i);
  assert.match(html, /<footer\b[^>]*>/i);
  assert.match(html, /<h1\b[^>]*>[^<]*Docker Snake[^<]*<\/h1>/i);
  assert.match(html, /<noscript\b[^>]*>[\s\S]*?<\/noscript>/i);
});

test('保留学习项目名称并显示全栈运行状态文案', async () => {
  const html = await readPage();
  const text = visibleText(html);
  const expectedCopy = [
    '用语义化 HTML 搭建终端游戏控制台',
    '$ docker-snake --mode full-stack',
    '游戏区域',
    '游戏尚未开始。',
    '等待确认登录状态…',
  ];
  const missingCopy = expectedCopy.filter((copy) => !text.includes(copy));

  assert.deepEqual(
    missingCopy,
    [],
    '缺少上一课既有文案：' + missingCopy.join('、'),
  );
});

test('提供课程所需的全部页面结构挂载点', async () => {
  const html = await readPage();
  const requiredIds = [
    'session-status',
    'auth-controls',
    'show-register',
    'show-login',
    'logout-account',
    'auth-panel',
    'auth-form',
    'auth-username',
    'auth-password',
    'confirm-password',
    'auth-message',
    'current-score',
    'best-score',
    'speed-level',
    'game-status',
    'game-canvas',
    'start-game',
    'toggle-pause',
    'restart-game',
    'retry-score',
    'touch-controls',
    'leaderboard-section',
    'leaderboard-status',
    'leaderboard-list',
    'my-rank',
    'refresh-leaderboard',
  ];

  for (const id of requiredIds) {
    assert.match(
      html,
      new RegExp(`\\bid=["']${id}["']`, 'i'),
      `缺少 #${id}`,
    );
  }
});

test('游戏区域公开文字状态、画布回退和基础控制', async () => {
  const html = await readPage();

  assert.match(
    html,
    /<[^>]+(?=[^>]*\bid=["']game-status["'])(?=[^>]*\baria-live=["']polite["'])[^>]*>/i,
  );
  assert.match(html, openingTagWithId('canvas', 'game-canvas'));
  assert.match(
    html,
    /<canvas\b(?=[^>]*\bid=["']game-canvas["'])(?=[^>]*\bwidth=["']600["'])(?=[^>]*\bheight=["']600["'])[^>]*>[\s\S]*不支持 Canvas[\s\S]*<\/canvas>/i,
  );

  for (const id of [
    'start-game',
    'toggle-pause',
    'restart-game',
    'retry-score',
  ]) {
    assert.match(html, openingTagWithId('button', id));
  }
  assert.match(
    html,
    /<button\b(?=[^>]*\bid=["']start-game["'])(?=[^>]*\bdisabled\b)[^>]*>/i,
  );
});

test('认证表单提供标签、自动填充和无障碍状态区', async () => {
  const html = await readPage();

  assert.match(html, /<form\b[^>]*\bid=["']auth-form["'][^>]*>/i);
  assert.match(html, /<label\b[^>]*\bfor=["']auth-username["'][^>]*>/i);
  assert.match(html, /<input\b(?=[^>]*\bid=["']auth-username["'])(?=[^>]*\bautocomplete=["']username["'])[^>]*>/i);
  assert.match(html, /<input\b(?=[^>]*\bid=["']auth-password["'])(?=[^>]*\btype=["']password["'])[^>]*>/i);
  assert.match(html, /<[^>]+(?=[^>]*\bid=["']auth-message["'])(?=[^>]*\baria-live=["']polite["'])[^>]*>/i);
  assert.doesNotMatch(html, /<input\b[^>]*\bid=["']auth-password["'][^>]*\bmaxlength=/i);
});

test('触控区恰好提供四个方向按钮', async () => {
  const html = await readPage();
  const directions = [...html.matchAll(/\bdata-direction=["']([^"']+)["']/gi)]
    .map((match) => match[1].toLowerCase())
    .sort();

  assert.deepEqual(directions, ['down', 'left', 'right', 'up']);
});

test('排行榜使用有序列表并保留状态与个人排名', async () => {
  const html = await readPage();

  assert.match(html, openingTagWithId('section', 'leaderboard-section'));
  assert.match(html, openingTagWithId('ol', 'leaderboard-list'));
  assert.match(
    html,
    /<[^>]+(?=[^>]*\bid=["']leaderboard-status["'])(?=[^>]*\baria-live=["']polite["'])[^>]*>/i,
  );
  assert.match(html, /\bid=["']my-rank["']/i);
});

test('游戏画布提供无障碍说明并通过 ES 模块加载静态预览', async () => {
  const html = await readPage();

  assert.match(
    html,
    /<canvas\b(?=[^>]*\bid=["']game-canvas["'])(?=[^>]*\brole=["']img["'])(?=[^>]*\baria-label=["']Docker Snake 游戏棋盘["'])(?=[^>]*\baria-describedby=["']game-status["'])[^>]*>/i,
  );
  assert.match(
    html,
    /<script\b(?=[^>]*\btype=["']module["'])(?=[^>]*\bsrc=["']\.\/scripts\/main\.js["'])[^>]*><\/script>/i,
  );
});
