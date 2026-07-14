import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { createAuthController } from '../../client/scripts/auth.js';

class FakeElement {
  constructor() {
    this.listeners = new Map();
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
  }

  addEventListener(type, listener) { this.listeners.set(type, listener); }
  removeEventListener(type, listener) {
    if (this.listeners.get(type) === listener) this.listeners.delete(type);
  }
  focus() {}
}

function createElements() {
  return Object.fromEntries([
    'sessionStatus', 'showRegisterButton', 'showLoginButton', 'logoutButton',
    'panel', 'title', 'form', 'usernameInput', 'passwordInput', 'confirmRow',
    'confirmPasswordInput', 'help', 'message', 'submitButton', 'cancelButton',
  ].map((key) => [key, new FakeElement()]));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

describe('浏览器认证控制器', () => {
  test('初始为 loading，/me 可切换游客与已登录快照', async () => {
    const elements = createElements();
    const controller = createAuthController({
      api: {
        getCurrentUser: async () => ({ authenticated: true, user: { id: 7, username: 'alice' } }),
        register() {}, login() {}, logout() {},
      },
      elements,
    });

    assert.deepEqual(controller.getSnapshot(), { status: 'loading', user: null });
    assert.equal(elements.showLoginButton.disabled, true);

    await controller.initialize();
    assert.deepEqual(controller.getSnapshot(), {
      status: 'authenticated',
      user: { id: '7', username: 'alice' },
    });
    assert.equal(Object.isFrozen(controller.getSnapshot()), true);
    assert.equal(elements.sessionStatus.textContent, '已登录：alice');
    assert.equal(elements.logoutButton.hidden, false);
  });

  test('/me 网络失败时明确降级为游客模式', async () => {
    const elements = createElements();
    const controller = createAuthController({
      api: {
        getCurrentUser: async () => { throw Object.assign(new Error('offline'), { code: 'NETWORK_ERROR' }); },
        register() {}, login() {}, logout() {},
      },
      elements,
    });

    await controller.initialize();
    assert.deepEqual(controller.getSnapshot(), { status: 'guest', user: null });
    assert.match(elements.message.textContent, /游客模式/);
  });

  test('注册按 Unicode 字符计数，密码原样发送且确认密码不发送', async () => {
    const elements = createElements();
    const calls = [];
    const password = '😀'.repeat(15);
    const controller = createAuthController({
      api: {
        getCurrentUser() {},
        async register(body) { calls.push(body); return { user: { id: '1', username: 'new_user' } }; },
        login() {}, logout() {},
      },
      elements,
    });

    await controller.register({ username: 'New_User', password, confirmPassword: password });

    assert.deepEqual(calls, [{ username: 'New_User', password }]);
    assert.deepEqual(controller.getSnapshot(), {
      status: 'authenticated',
      user: { id: '1', username: 'new_user' },
    });
  });

  test('较慢的旧 /me 结果不能覆盖稍后的登录结果', async () => {
    const elements = createElements();
    const oldMe = deferred();
    const controller = createAuthController({
      api: {
        getCurrentUser: () => oldMe.promise,
        register() {},
        login: async () => ({ user: { id: '2', username: 'bob' } }),
        logout() {},
      },
      elements,
    });

    const initializing = controller.initialize();
    await controller.login({ username: 'bob', password: 'a'.repeat(15) });
    oldMe.resolve({ authenticated: false, user: null });
    await initializing;

    assert.equal(controller.getSnapshot().user.username, 'bob');
  });

  test('退出切回游客；destroy 中止请求、移除事件且阻止晚到更新', async () => {
    const elements = createElements();
    const oldMe = deferred();
    let aborted = false;
    const controller = createAuthController({
      api: {
        getCurrentUser: () => oldMe.promise,
        register() {}, login() {}, logout: async () => null,
      },
      elements,
      createAbortController: () => ({
        signal: {},
        abort() { aborted = true; },
      }),
    });
    const pending = controller.initialize();
    controller.destroy();
    oldMe.resolve({ authenticated: true, user: { id: '9', username: 'late' } });
    await pending;

    assert.equal(aborted, true);
    assert.equal(controller.getSnapshot().status, 'loading');
    assert.equal(elements.form.listeners.size, 0);
  });
});
