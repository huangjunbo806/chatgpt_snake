import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import express from 'express';
import session from 'express-session';
import request from 'supertest';

import {
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_MS,
  clearSessionCookie,
  createSessionMiddleware,
  destroySession,
  establishLoginSession,
  regenerateSession,
  saveSession,
} from '../../server/auth/session.js';

const SESSION_SECRET = 'test-session-secret-that-is-at-least-32-bytes';

class RecordingMemoryStore extends session.MemoryStore {
  constructor() {
    super();
    this.calls = { get: 0, set: 0, destroy: 0, touch: 0 };
  }

  get(sid, callback) {
    this.calls.get += 1;
    super.get(sid, callback);
  }

  set(sid, value, callback) {
    this.calls.set += 1;
    super.set(sid, value, callback);
  }

  destroy(sid, callback) {
    this.calls.destroy += 1;
    super.destroy(sid, callback);
  }

  touch(sid, value, callback) {
    this.calls.touch += 1;
    super.touch(sid, value, callback);
  }
}

function buildSessionApp({ nodeEnv = 'test', store = new RecordingMemoryStore() } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(createSessionMiddleware({
    store,
    config: { nodeEnv, sessionSecret: SESSION_SECRET },
  }));
  app.get('/guest', (req, res) => {
    res.json({ guest: true });
  });
  app.post('/login', (req, res) => {
    req.session.userId = '42';
    res.json({ userId: req.session.userId });
  });
  app.get('/current', (req, res) => {
    res.json({ userId: req.session.userId ?? null });
  });

  return { app, store };
}

describe('Session 配置与 Promise helpers', () => {
  test('拒绝缺失或非法 store，不静默降级到进程内 MemoryStore', () => {
    const config = { nodeEnv: 'production', sessionSecret: SESSION_SECRET };

    for (const store of [undefined, {}, { on() {} }]) {
      assert.throws(
        () => createSessionMiddleware({ store, config }),
        /createSessionMiddleware.*store/u,
      );
    }
  });

  test('使用通用 Cookie 名、7 天期限和开发环境安全属性', async () => {
    const { app, store } = buildSessionApp();
    const agent = request.agent(app);

    const guest = await agent.get('/guest');
    const login = await agent.post('/login');
    const current = await agent.get('/current');

    assert.equal(SESSION_COOKIE_NAME, 'app_session');
    assert.equal(SESSION_MAX_AGE_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(guest.headers['set-cookie'], undefined);
    assert.equal(login.status, 200);
    assert.deepEqual(login.body, { userId: '42' });
    assert.deepEqual(current.body, { userId: '42' });

    const cookie = login.headers['set-cookie'][0];
    assert.match(cookie, /^app_session=/u);
    assert.match(cookie, /; Path=\//u);
    assert.match(cookie, /; HttpOnly/u);
    assert.match(cookie, /; SameSite=Lax/u);
    assert.doesNotMatch(cookie, /; Secure/u);

    const expiresText = /Expires=([^;]+)/u.exec(cookie)?.[1];
    assert.ok(expiresText);
    const remaining = Date.parse(expiresText) - Date.now();
    assert.ok(remaining <= SESSION_MAX_AGE_MS);
    assert.ok(remaining >= SESSION_MAX_AGE_MS - 5_000);

    assert.equal(current.headers['set-cookie'], undefined);
    assert.equal(store.calls.set, 1);
  });

  test('production Cookie 仅在 HTTPS 代理请求中带 Secure', async () => {
    const { app } = buildSessionApp({ nodeEnv: 'production' });
    const response = await request(app)
      .post('/login')
      .set('X-Forwarded-Proto', 'https');

    assert.equal(response.status, 200);
    assert.match(response.headers['set-cookie'][0], /; Secure/u);
  });

  test('regenerate 后写字符串 userId，再 save', async () => {
    const events = [];
    const req = {
      session: {
        regenerate(callback) {
          events.push('regenerate');
          req.session = {
            save(saveCallback) {
              events.push(`save:${req.session.userId}`);
              saveCallback();
            },
          };
          callback();
        },
      },
    };

    await establishLoginSession(req, 9007199254740993n);

    assert.deepEqual(events, ['regenerate', 'save:9007199254740993']);
    assert.equal(req.session.userId, '9007199254740993');
  });

  test('regenerate/save/destroy 均把 callback 错误原样传播给 Promise', async () => {
    for (const [helper, method] of [
      [regenerateSession, 'regenerate'],
      [saveSession, 'save'],
      [destroySession, 'destroy'],
    ]) {
      const expected = new Error(`${method}-failed`);
      const req = {
        session: {
          [method](callback) {
            callback(expected);
          },
        },
      };

      await assert.rejects(helper(req), (error) => error === expected);
    }
  });

  test('清 Cookie 复用名称和属性，不向 clearCookie 传 maxAge/Expires', () => {
    const calls = [];
    clearSessionCookie({
      clearCookie(name, options) {
        calls.push({ name, options });
      },
    }, { secure: true });

    assert.deepEqual(calls, [{
      name: SESSION_COOKIE_NAME,
      options: {
        httpOnly: true,
        sameSite: 'lax',
        secure: true,
        path: '/',
      },
    }]);
    assert.equal('maxAge' in calls[0].options, false);
    assert.equal('expires' in calls[0].options, false);
  });
});
