import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import express from 'express';
import request from 'supertest';

import { createApp } from '../../server/app.js';
import { AppError } from '../../server/errors.js';

const PROJECT_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const PUBLIC_ORIGIN = 'http://localhost:3000';
const CONFIG = Object.freeze({
  nodeEnv: 'test',
  publicOrigin: PUBLIC_ORIGIN,
  staticRoot: path.resolve(PROJECT_ROOT, 'client'),
  trustProxy: 0,
});

function createLogger() {
  const entries = [];
  return {
    entries,
    error(context, message) {
      entries.push({ context, message });
    },
  };
}

function sequenceRequestIds(prefix = 'request') {
  let count = 0;
  return () => `${prefix}-${++count}`;
}

function testRouter(state = {}) {
  const router = express.Router();

  router.get('/read', (req, res) => {
    state.readCount = (state.readCount ?? 0) + 1;
    res.json({ data: { readable: true, sessionMarker: req.sessionMarker ?? null } });
  });
  const writeHandler = (req, res) => {
    state.writeCount = (state.writeCount ?? 0) + 1;
    res.status(201).json({ data: req.body });
  };
  router.route('/write')
    .post(writeHandler)
    .put(writeHandler)
    .patch(writeHandler)
    .delete(writeHandler);
  router.post('/echo', (req, res) => {
    res.json({ data: { length: req.body.value.length } });
  });
  router.get('/ip', (req, res) => {
    res.json({ data: { ip: req.ip } });
  });
  router.get('/known-error', () => {
    throw new AppError({
      status: 422,
      code: 'KNOWN_PROBLEM',
      message: '公开的中文错误',
    });
  });
  router.get('/unknown-error', () => {
    throw new Error('SQL password=internal-db-password at /srv/private/file.js');
  });
  router.get('/leak/:secret', () => {
    throw new Error('内部动态路径处理失败');
  });
  router.get('/async-error', async () => {
    await Promise.resolve();
    throw new Error('postgresql://user:async-db-password@db.example.test/snake');
  });
  router.get('/headers-sent', (req, res, next) => {
    const error = new Error('headers-sent-original-error');
    state.headersSentError = error;
    res.write('partial');
    next(error);
  });

  return router;
}

function buildApp(overrides = {}) {
  return createApp({
    config: CONFIG,
    healthCheck: async () => true,
    logger: createLogger(),
    requestIdFactory: sequenceRequestIds(),
    ...overrides,
  });
}

function protectedPost(app, pathname) {
  return request(app)
    .post(pathname)
    .set('Content-Type', 'application/json')
    .set('X-Docker-Snake-Request', '1')
    .set('Origin', PUBLIC_ORIGIN);
}

function jsonDocumentWithBytes(size) {
  const framing = Buffer.byteLength('{"value":""}', 'utf8');
  return `{"value":"${'x'.repeat(size - framing)}"}`;
}

function createBodyParserReadError(type) {
  const expected = 128;
  const received = type === 'request.aborted' ? 64 : 127;

  return Object.assign(new Error(type), {
    status: 400,
    statusCode: 400,
    expose: true,
    expected,
    length: expected,
    received,
    type,
    ...(type === 'request.aborted' ? { code: 'ECONNABORTED' } : {}),
  });
}

describe('createApp 基础 HTTP 行为', () => {
  test('从配置的静态目录返回首页 HTML', async () => {
    const response = await request(buildApp()).get('/');

    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /^text\/html/u);
    assert.match(response.text, /<!doctype html>/iu);
  });

  test('健康检查成功返回固定 data envelope', async () => {
    const response = await request(buildApp()).get('/healthz');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { data: { status: 'ok' } });
  });

  test('健康检查返回 false 时给出稳定的 503 错误', async () => {
    const response = await request(buildApp({
      healthCheck: async () => false,
      requestIdFactory: () => 'health-false',
    })).get('/healthz');

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, {
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂不可用',
        requestId: 'health-false',
      },
    });
  });

  test('健康检查抛错时记录上下文但不泄漏数据库错误', async () => {
    const logger = createLogger();
    const response = await request(buildApp({
      healthCheck: async () => {
        throw new Error('database password=health-db-password');
      },
      logger,
      requestIdFactory: () => 'health-error',
    })).get('/healthz');

    assert.equal(response.status, 503);
    assert.equal(response.body.error.code, 'SERVICE_UNAVAILABLE');
    assert.equal(response.body.error.requestId, 'health-error');
    assert.doesNotMatch(response.text, /health-db-password|database|stack/iu);
    assert.equal(logger.entries.length, 1);
    assert.equal(logger.entries[0].context.requestId, 'health-error');
    assert.doesNotMatch(inspect(logger.entries), /health-db-password|database password/iu);
  });

  test('每次生成服务端 requestId、设置响应头且忽略客户端 ID', async () => {
    const app = createApp({
      config: CONFIG,
      healthCheck: async () => false,
      logger: createLogger(),
    });

    const first = await request(app).get('/healthz').set('X-Request-Id', 'client-chosen-id');
    const second = await request(app).get('/healthz').set('X-Request-Id', 'another-client-id');

    assert.ok(first.headers['x-request-id']);
    assert.ok(second.headers['x-request-id']);
    assert.notEqual(first.headers['x-request-id'], 'client-chosen-id');
    assert.notEqual(second.headers['x-request-id'], 'another-client-id');
    assert.notEqual(first.headers['x-request-id'], second.headers['x-request-id']);
    assert.equal(first.body.error.requestId, first.headers['x-request-id']);
    assert.equal(second.body.error.requestId, second.headers['x-request-id']);
  });

  test('启用 Helmet、安全响应头、隐藏 Express 指纹且不启用 CORS', async () => {
    const developmentResponse = await request(buildApp()).get('/healthz');
    const productionResponse = await request(buildApp({
      config: { ...CONFIG, nodeEnv: 'production', publicOrigin: 'https://snake.example.test' },
    })).get('/healthz');

    assert.ok(developmentResponse.headers['content-security-policy']);
    assert.doesNotMatch(developmentResponse.headers['content-security-policy'], /upgrade-insecure-requests/u);
    assert.match(productionResponse.headers['content-security-policy'], /upgrade-insecure-requests/u);
    assert.equal(developmentResponse.headers['x-content-type-options'], 'nosniff');
    assert.equal(developmentResponse.headers['x-powered-by'], undefined);
    assert.equal(developmentResponse.headers['access-control-allow-origin'], undefined);
  });

  test('默认 session no-op 可用，也能在路由前注入 session 中间件', async () => {
    const router = testRouter();
    const defaultResponse = await request(buildApp({
      routers: [{ path: '/api/test', router }],
    })).get('/api/test/read');
    const injectedResponse = await request(buildApp({
      sessionMiddleware(req, res, next) {
        req.sessionMarker = 'session-ready';
        next();
      },
      routers: [{ path: '/api/test', router }],
    })).get('/api/test/read');

    assert.equal(defaultResponse.status, 200);
    assert.equal(defaultResponse.body.data.sessionMarker, null);
    assert.equal(injectedResponse.body.data.sessionMarker, 'session-ready');
  });

  test('按 trustProxy 配置决定是否信任转发客户端 IP', async () => {
    const router = testRouter();
    const directResponse = await request(buildApp({
      config: { ...CONFIG, trustProxy: 0 },
      routers: [{ path: '/api/test', router }],
    })).get('/api/test/ip').set('X-Forwarded-For', '203.0.113.10');
    const proxiedResponse = await request(buildApp({
      config: { ...CONFIG, trustProxy: 1 },
      routers: [{ path: '/api/test', router }],
    })).get('/api/test/ip').set('X-Forwarded-For', '203.0.113.10');

    assert.notEqual(directResponse.body.data.ip, '203.0.113.10');
    assert.equal(proxiedResponse.body.data.ip, '203.0.113.10');
  });
});

describe('同源 JSON 写请求保护', () => {
  test('GET/HEAD 不受写保护', async () => {
    const app = buildApp({ routers: [{ path: '/api/test', router: testRouter() }] });

    const getResponse = await request(app).get('/api/test/read');
    const headResponse = await request(app).head('/api/test/read');

    assert.equal(getResponse.status, 200);
    assert.equal(headResponse.status, 200);
  });

  test('分别拒绝错误 Content-Type、自定义头和 Origin', async (t) => {
    const state = {};
    const app = buildApp({
      requestIdFactory: sequenceRequestIds('write-rejected'),
      routers: [{ path: '/api/test', router: testRouter(state) }],
    });

    await t.test('Content-Type 必须是 application/json', async () => {
      const response = await request(app)
        .post('/api/test/write')
        .set('Content-Type', 'text/plain')
        .set('X-Docker-Snake-Request', '1')
        .set('Origin', PUBLIC_ORIGIN)
        .send('{}');

      assert.equal(response.status, 415);
      assert.equal(response.body.error.code, 'JSON_CONTENT_TYPE_REQUIRED');
      assert.equal(response.headers['cache-control'], 'no-store');
    });

    await t.test('自定义头必须精确为 1', async () => {
      const response = await request(app)
        .post('/api/test/write')
        .set('Content-Type', 'application/json')
        .set('X-Docker-Snake-Request', '0')
        .set('Origin', PUBLIC_ORIGIN)
        .send('{}');

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'WRITE_HEADER_REQUIRED');
      assert.equal(response.headers['cache-control'], 'no-store');
    });

    await t.test('Origin 必须与配置精确相同', async () => {
      const response = await request(app)
        .post('/api/test/write')
        .set('Content-Type', 'application/json')
        .set('X-Docker-Snake-Request', '1')
        .set('Origin', `${PUBLIC_ORIGIN}/`)
        .send('{}');

      assert.equal(response.status, 403);
      assert.equal(response.body.error.code, 'ORIGIN_NOT_ALLOWED');
      assert.equal(response.headers['cache-control'], 'no-store');
    });

    assert.equal(state.writeCount, undefined);
  });

  test('三项校验合法时请求进入注入的真实 Express router', async () => {
    const state = {};
    const app = buildApp({ routers: [{ path: '/api/test', router: testRouter(state) }] });
    const response = await protectedPost(app, '/api/test/write').send({ score: 10 });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { data: { score: 10 } });
    assert.equal(state.writeCount, 1);
  });

  test('PUT、PATCH、DELETE 与 POST 使用相同写保护', async (t) => {
    const state = {};
    const app = buildApp({ routers: [{ path: '/api/test', router: testRouter(state) }] });

    for (const method of ['put', 'patch', 'delete']) {
      await t.test(method.toUpperCase(), async () => {
        const response = await request(app)[method]('/api/test/write')
          .set('Content-Type', 'application/json')
          .set('Origin', PUBLIC_ORIGIN)
          .send('{}');

        assert.equal(response.status, 403);
        assert.equal(response.body.error.code, 'WRITE_HEADER_REQUIRED');
      });
    }

    assert.equal(state.writeCount, undefined);
  });
});

describe('JSON 请求体与统一错误处理', () => {
  test('非分数 API 保持原有 strict JSON parser 行为', async () => {
    const response = await protectedPost(buildApp({
      requestIdFactory: () => 'strict-json',
      routers: [{ path: '/api/test', router: testRouter() }],
    }), '/api/test/write').send('"valid-json-scalar"');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, {
      error: {
        code: 'INVALID_JSON',
        message: '请求体必须是有效的 JSON',
        requestId: 'strict-json',
      },
    });
    assert.equal(response.headers['cache-control'], 'no-store');
  });

  test('解析合法 JSON 并拒绝非法 JSON', async () => {
    const app = buildApp({
      requestIdFactory: sequenceRequestIds('json'),
      routers: [{ path: '/api/test', router: testRouter() }],
    });
    const valid = await protectedPost(app, '/api/test/write').send({ value: '合法' });
    const invalid = await protectedPost(app, '/api/test/write').send('{"value":');

    assert.equal(valid.status, 201);
    assert.deepEqual(valid.body, { data: { value: '合法' } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(invalid.body, {
      error: {
        code: 'INVALID_JSON',
        message: '请求体必须是有效的 JSON',
        requestId: 'json-2',
      },
    });
    assert.equal(invalid.headers['cache-control'], 'no-store');
  });

  test('接受恰好 16 KiB 的 JSON，超出一个字节返回 413', async () => {
    const app = buildApp({
      requestIdFactory: sequenceRequestIds('size'),
      routers: [{ path: '/api/test', router: testRouter() }],
    });
    const atLimit = jsonDocumentWithBytes(16 * 1024);
    const overLimit = jsonDocumentWithBytes((16 * 1024) + 1);

    assert.equal(Buffer.byteLength(atLimit), 16 * 1024);
    assert.equal(Buffer.byteLength(overLimit), (16 * 1024) + 1);

    const accepted = await protectedPost(app, '/api/test/echo').send(atLimit);
    const rejected = await protectedPost(app, '/api/test/echo').send(overLimit);

    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.data.length, (16 * 1024) - Buffer.byteLength('{"value":""}'));
    assert.equal(rejected.status, 413);
    assert.deepEqual(rejected.body, {
      error: {
        code: 'PAYLOAD_TOO_LARGE',
        message: '请求体不能超过 16 KiB',
        requestId: 'size-2',
      },
    });
  });

  test('不支持的 JSON charset 与 content encoding 稳定返回 415', async () => {
    const app = buildApp({
      requestIdFactory: sequenceRequestIds('unsupported'),
      routers: [{ path: '/api/test', router: testRouter() }],
    });
    const charsetResponse = await request(app)
      .post('/api/test/write')
      .set('Content-Type', 'application/json; charset=iso-8859-1')
      .set('X-Docker-Snake-Request', '1')
      .set('Origin', PUBLIC_ORIGIN)
      .send('{}');
    const encodingResponse = await request(app)
      .post('/api/test/write')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'compress')
      .set('X-Docker-Snake-Request', '1')
      .set('Origin', PUBLIC_ORIGIN)
      .send('{}');

    for (const [response, requestId] of [
      [charsetResponse, 'unsupported-1'],
      [encodingResponse, 'unsupported-2'],
    ]) {
      assert.equal(response.status, 415);
      assert.deepEqual(response.body, {
        error: {
          code: 'UNSUPPORTED_MEDIA_TYPE',
          message: '不支持请求体的字符集或内容编码',
          requestId,
        },
      });
    }
  });

  test('body-parser 读取中止与长度不符稳定返回 400 且不记录 5xx', async (t) => {
    const logger = createLogger();
    const router = express.Router();
    const cases = [
      {
        type: 'request.aborted',
        path: '/aborted',
        code: 'REQUEST_ABORTED',
        message: '请求体传输未完成',
      },
      {
        type: 'request.size.invalid',
        path: '/size-invalid',
        code: 'REQUEST_SIZE_INVALID',
        message: '请求体长度与声明不一致',
      },
    ];

    for (const testCase of cases) {
      router.get(testCase.path, (req, res, next) => {
        next(createBodyParserReadError(testCase.type));
      });
    }

    const app = buildApp({
      logger,
      requestIdFactory: sequenceRequestIds('body-read'),
      routers: [{ path: '/api/body-parser', router }],
    });

    for (const [index, testCase] of cases.entries()) {
      await t.test(testCase.type, async () => {
        const response = await request(app).get(`/api/body-parser${testCase.path}`);

        assert.equal(response.status, 400);
        assert.deepEqual(response.body, {
          error: {
            code: testCase.code,
            message: testCase.message,
            requestId: `body-read-${index + 1}`,
          },
        });
      });
    }

    assert.deepEqual(logger.entries, []);
  });

  test('AppError 保留公开状态、稳定码与中文消息', async () => {
    const response = await request(buildApp({
      requestIdFactory: () => 'known-error',
      routers: [{ path: '/api/test', router: testRouter() }],
    })).get('/api/test/known-error');

    assert.equal(response.status, 422);
    assert.deepEqual(response.body, {
      error: {
        code: 'KNOWN_PROBLEM',
        message: '公开的中文错误',
        requestId: 'known-error',
      },
    });
  });

  test('不存在的 API 与页面返回各自稳定的 404', async () => {
    const app = buildApp({ requestIdFactory: sequenceRequestIds('missing') });
    const apiResponse = await request(app).get('/api/missing');
    const pageResponse = await request(app).get('/missing-page');

    assert.equal(apiResponse.status, 404);
    assert.equal(apiResponse.body.error.code, 'API_NOT_FOUND');
    assert.equal(apiResponse.body.error.requestId, 'missing-1');
    assert.equal(pageResponse.status, 404);
    assert.equal(pageResponse.body.error.code, 'NOT_FOUND');
    assert.equal(pageResponse.body.error.requestId, 'missing-2');
  });

  test('未知错误返回 500，日志不记录查询或动态路径参数', async () => {
    const logger = createLogger();
    const response = await request(buildApp({
      logger,
      requestIdFactory: () => 'unknown-error',
      routers: [{ path: '/api/test', router: testRouter() }],
    })).get('/api/test/leak/reset-token-secret?token=query-session-cookie');

    assert.equal(response.status, 500);
    assert.deepEqual(response.body, {
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
        requestId: 'unknown-error',
      },
    });
    assert.doesNotMatch(response.text, /internal-db-password|SQL|private|stack/iu);
    assert.equal(logger.entries.length, 1);
    assert.deepEqual(logger.entries[0], {
      context: {
        event: 'http_request_failed',
        requestId: 'unknown-error',
        method: 'GET',
        errorType: 'INTERNAL_ERROR',
      },
      message: '请求处理失败',
    });
    assert.doesNotMatch(
      inspect(logger.entries),
      /password|hash|session|cookie|postgresql:|reset-token-secret|query-session-cookie/iu,
    );
  });

  test('Express 5 转发 async rejection 且日志不记录连接串', async () => {
    const logger = createLogger();
    const response = await request(buildApp({
      logger,
      requestIdFactory: () => 'async-error',
      routers: [{ path: '/api/test', router: testRouter() }],
    })).get('/api/test/async-error');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.equal(response.body.error.requestId, 'async-error');
    assert.doesNotMatch(response.text, /async-db-password|postgresql:/u);
    assert.doesNotMatch(inspect(logger.entries), /async-db-password|postgresql:/u);
  });

  test('session middleware 失败时不执行业务路由且不泄漏会话信息', async () => {
    const logger = createLogger();
    const state = {};
    const response = await request(buildApp({
      logger,
      requestIdFactory: () => 'session-error',
      sessionMiddleware(req, res, next) {
        next(new Error('sessionId=sid-secret cookie=connect.sid hash=secret-hash'));
      },
      routers: [{ path: '/api/test', router: testRouter(state) }],
    })).get('/api/test/read');

    assert.equal(response.status, 500);
    assert.equal(response.body.error.code, 'INTERNAL_ERROR');
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(state.readCount, undefined);
    assert.doesNotMatch(response.text, /sid-secret|connect\.sid|secret-hash/u);
    assert.doesNotMatch(inspect(logger.entries), /sid-secret|connect\.sid|secret-hash/u);
  });

  test('响应头已发送时把原错误继续交给下一个错误中间件', async () => {
    const state = {};
    const app = buildApp({ routers: [{ path: '/api/test', router: testRouter(state) }] });
    let forwardedError;
    app.use((error, req, res, next) => {
      forwardedError = error;
      res.end();
    });

    const response = await request(app).get('/api/test/headers-sent');

    assert.equal(response.status, 200);
    assert.equal(response.text, 'partial');
    assert.equal(forwardedError, state.headersSentError);
  });
});
