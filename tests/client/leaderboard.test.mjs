import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createLeaderboardController } from '../../client/scripts/leaderboard.js';

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.textContent = '';
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
  }
  set innerHTML(_) { throw new Error('排行榜禁止使用 innerHTML'); }
  replaceChildren(...children) { this.children = children; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
}

function createElements() {
  return {
    status: new FakeElement(),
    list: new FakeElement('ol'),
    myRank: new FakeElement(),
    refreshButton: new FakeElement('button'),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('休闲排行榜控制器', () => {
  test('使用 textContent 安全显示服务端排名，并同步当前用户最高分', async () => {
    const elements = createElements();
    const serverBest = [];
    const controller = createLeaderboardController({
      api: {
        async getLeaderboard() {
          return {
            entries: [{ rank: 1, username: '<img src=x onerror=alert(1)>', bestScore: 300 }],
            me: { rank: 105, username: 'alice', bestScore: 20, bestScoreAt: null },
          };
        },
      },
      elements,
      documentRef: { createElement: (tag) => new FakeElement(tag) },
      getAuthSnapshot: () => ({ status: 'authenticated', user: { id: '7', username: 'alice' } }),
      onServerBest: (value) => serverBest.push(value),
    });

    await controller.refresh();

    assert.equal(elements.list.children.length, 1);
    assert.equal(elements.list.children[0].textContent, '#1  <img src=x onerror=alert(1)>  ·  300 分');
    assert.equal(elements.myRank.textContent, '我的排名：#105 · 最高分 20');
    assert.deepEqual(serverBest, [{ userId: '7', bestScore: 20 }]);
  });

  test('空榜和零分用户使用清晰文案', async () => {
    const elements = createElements();
    const controller = createLeaderboardController({
      api: { getLeaderboard: async () => ({ entries: [], me: { rank: null, bestScore: 0 } }) },
      elements,
      documentRef: { createElement: (tag) => new FakeElement(tag) },
      getAuthSnapshot: () => ({ status: 'authenticated', user: { id: '1', username: 'new' } }),
    });

    await controller.refresh();
    assert.equal(elements.list.children[0].textContent, '暂无已提交成绩');
    assert.equal(elements.myRank.textContent, '我的排名：尚未上榜 · 最高分 0');
  });

  test('后发请求先完成时，旧响应不能覆盖新排行榜', async () => {
    const elements = createElements();
    const first = deferred();
    const second = deferred();
    let call = 0;
    const controller = createLeaderboardController({
      api: { getLeaderboard: () => (++call === 1 ? first.promise : second.promise) },
      elements,
      documentRef: { createElement: (tag) => new FakeElement(tag) },
      getAuthSnapshot: () => ({ status: 'guest', user: null }),
      createAbortController: () => ({ signal: {}, abort() {} }),
    });

    const oldRequest = controller.refresh();
    const newRequest = controller.refresh();
    second.resolve({ entries: [{ rank: 1, username: 'new', bestScore: 200 }], me: null });
    await newRequest;
    first.resolve({ entries: [{ rank: 1, username: 'old', bestScore: 10 }], me: null });
    await oldRequest;

    assert.match(elements.list.children[0].textContent, /new/);
  });

  test('认证变化和 destroy 都中止旧请求并清理刷新事件', async () => {
    const elements = createElements();
    const request = deferred();
    let aborts = 0;
    let snapshot = { status: 'guest', user: null };
    const controller = createLeaderboardController({
      api: { getLeaderboard: () => request.promise },
      elements,
      documentRef: { createElement: (tag) => new FakeElement(tag) },
      getAuthSnapshot: () => snapshot,
      createAbortController: () => ({ signal: {}, abort() { aborts += 1; } }),
    });

    void controller.refresh();
    snapshot = { status: 'loading', user: null };
    controller.handleAuthChange(snapshot);
    controller.destroy();
    request.resolve({ entries: [], me: null });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(aborts, 1);
    assert.equal(elements.refreshButton.listeners.size, 0);
    assert.equal(elements.status.textContent, '等待确认登录状态…');
  });
});
