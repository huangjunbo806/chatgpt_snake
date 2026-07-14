import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';

import { loadConfig } from '../../server/config.js';

const REQUIRED_ENV = Object.freeze({
  DATABASE_URL: 'postgresql://snake_user:db-password@localhost:5432/snake',
  SESSION_SECRET: 'a-secure-session-secret-with-32-bytes',
  PUBLIC_ORIGIN: 'http://localhost:3000',
});

function envWith(overrides = {}) {
  return { ...REQUIRED_ENV, ...overrides };
}

function assertConfigError(overrides, pattern) {
  assert.throws(() => loadConfig(envWith(overrides), { rootDir: '/tmp/docker-snake' }), pattern);
}

describe('loadConfig 合法配置', () => {
  test('应用开发环境默认值、解析静态目录并返回冻结对象', () => {
    const config = loadConfig(REQUIRED_ENV, { rootDir: '/tmp/docker-snake' });

    assert.deepEqual(config, {
      nodeEnv: 'development',
      port: 3000,
      host: '0.0.0.0',
      databaseUrl: REQUIRED_ENV.DATABASE_URL,
      sessionSecret: REQUIRED_ENV.SESSION_SECRET,
      publicOrigin: 'http://localhost:3000',
      trustProxy: 0,
      staticRoot: path.resolve('/tmp/docker-snake', 'client'),
    });
    assert.equal(Object.isFrozen(config), true);
  });

  test('接受边界值、postgres URL 与多字节 secret', () => {
    const config = loadConfig(envWith({
      NODE_ENV: 'test',
      PORT: '65535',
      HOST: '127.0.0.1',
      DATABASE_URL: 'postgres://snake_user@db.example.test/snake',
      SESSION_SECRET: '密密密密密密密密密密密',
      PUBLIC_ORIGIN: 'https://example.test:443/',
      TRUST_PROXY: '10',
    }), { rootDir: '/srv/app' });

    assert.equal(config.port, 65535);
    assert.equal(config.host, '127.0.0.1');
    assert.equal(config.publicOrigin, 'https://example.test');
    assert.equal(config.trustProxy, 10);
    assert.equal(config.staticRoot, path.resolve('/srv/app', 'client'));
  });

  test('生产环境使用 dist 并接受 HTTPS origin', () => {
    const config = loadConfig(envWith({
      NODE_ENV: 'production',
      PUBLIC_ORIGIN: 'https://snake.example.test',
    }), { rootDir: '/srv/app' });

    assert.equal(config.staticRoot, path.resolve('/srv/app', 'dist'));
    assert.equal(config.publicOrigin, 'https://snake.example.test');
  });
});

describe('loadConfig 拒绝非法配置', () => {
  test('NODE_ENV 只能是三种已知环境', () => {
    assertConfigError({ NODE_ENV: 'staging' }, /NODE_ENV.*development.*test.*production/u);
  });

  test('PORT 必须是 1 到 65535 的整数', async (t) => {
    for (const value of ['0', '65536', '3.14', 'abc', '']) {
      await t.test(`拒绝 ${JSON.stringify(value)}`, () => {
        assertConfigError({ PORT: value }, /PORT.*1.*65535.*整数/u);
      });
    }
  });

  test('HOST 不能为空或全是空白', () => {
    assertConfigError({ HOST: '   ' }, /HOST.*不能为空/u);
  });

  test('DATABASE_URL 必须是带主机的 postgres 或 postgresql URL', async (t) => {
    for (const value of [
      'mysql://snake_user:db-password@localhost/snake',
      'not-a-database-url',
      'postgresql:///snake',
    ]) {
      await t.test(`拒绝 ${value.split(':')[0]}`, () => {
        assertConfigError({ DATABASE_URL: value }, /DATABASE_URL.*postgres/u);
      });
    }
  });

  test('SESSION_SECRET 按 UTF-8 字节数计算且至少 32 字节', () => {
    assertConfigError({ SESSION_SECRET: '密'.repeat(10) }, /SESSION_SECRET.*32.*字节/u);
  });

  test('PUBLIC_ORIGIN 必须是纯 http 或 https origin', async (t) => {
    const cases = [
      'ftp://example.test',
      'https://example.test/path',
      'https://example.test/a/..',
      'https://example.test/%2e',
      'https://example.test\\path\\..',
      'https://example.test?debug=1',
      'https://example.test#debug',
      'https://user:password@example.test',
      'not-an-origin',
    ];

    for (const value of cases) {
      await t.test(`拒绝 ${value}`, () => {
        assertConfigError({ PUBLIC_ORIGIN: value }, /PUBLIC_ORIGIN.*origin/u);
      });
    }
  });

  test('production 的 PUBLIC_ORIGIN 必须使用 HTTPS', () => {
    assertConfigError({ NODE_ENV: 'production', PUBLIC_ORIGIN: 'http://localhost:3000' }, /production.*HTTPS/u);
  });

  test('TRUST_PROXY 必须是 0 到 10 的整数', async (t) => {
    for (const value of ['-1', '11', '1.5', 'abc', '']) {
      await t.test(`拒绝 ${JSON.stringify(value)}`, () => {
        assertConfigError({ TRUST_PROXY: value }, /TRUST_PROXY.*0.*10.*整数/u);
      });
    }
  });
});

test('配置错误不回显 session secret 或数据库密码', () => {
  const secret = 'too-short-secret';
  const password = 'do-not-leak-this-password';

  assert.throws(
    () => loadConfig(envWith({ SESSION_SECRET: secret }), { rootDir: '/tmp/docker-snake' }),
    (error) => !error.message.includes(secret) && !error.message.includes(password),
  );

  assert.throws(
    () => loadConfig(envWith({
      DATABASE_URL: `mysql://snake_user:${password}@localhost/snake`,
    }), { rootDir: '/tmp/docker-snake' }),
    (error) => !error.message.includes(secret) && !error.message.includes(password),
  );
});
