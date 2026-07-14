import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  ApiError,
  createApiClient,
} from '../../client/scripts/api.js';

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  });
}

function emptyResponse({ status = 204, headers = {} } = {}) {
  return new Response(null, { status, headers });
}

function createFetchRecorder(responder = () => jsonResponse({ data: null })) {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return responder(...args);
  };
  return { calls, fetchImpl };
}

function assertSameOriginGetCall(call, expectedUrl, signal) {
  const [url, init] = call;
  assert.equal(url, expectedUrl);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.signal, signal);
  assert.equal(Object.hasOwn(init, 'headers'), false);
  assert.equal(Object.hasOwn(init, 'body'), false);
}

function assertSameOriginPostCall(call, expectedUrl, expectedBody, signal) {
  const [url, init] = call;
  const headers = new Headers(init.headers);

  assert.equal(url, expectedUrl);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.signal, signal);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('X-Docker-Snake-Request'), '1');
  assert.equal(headers.has('Origin'), false);
  assert.equal([...headers].length, 2);
  assert.equal(init.body, JSON.stringify(expectedBody));
}

describe('浏览器同源 API 客户端', () => {
  test('尽早拒绝不可调用的 fetch，并冻结客户端及其公开方法', () => {
    for (const fetchImpl of [null, false, {}, 'fetch']) {
      assert.throws(
        () => createApiClient({ fetchImpl }),
        (error) => error instanceof TypeError && error.message === 'fetchImpl 必须是函数',
      );
    }

    const client = createApiClient({ fetchImpl: async () => jsonResponse({ data: null }) });

    assert.equal(Object.isFrozen(client), true);
    assert.deepEqual(Reflect.ownKeys(client), [
      'getCurrentUser',
      'register',
      'login',
      'logout',
      'submitScore',
      'getLeaderboard',
    ]);
    for (const method of Object.values(client)) {
      assert.equal(typeof method, 'function');
      assert.equal(Object.isFrozen(method), true);
    }
  });

  test('getCurrentUser 发送不带写请求头的同源 GET，并透传 signal', async () => {
    const result = Object.freeze({ user: { id: '1', username: 'neo', bestScore: 80 } });
    const { calls, fetchImpl } = createFetchRecorder(() => jsonResponse({ data: result }));
    const signal = new AbortController().signal;

    const actual = await createApiClient({ fetchImpl }).getCurrentUser({ signal });

    assert.deepEqual(actual, result);
    assert.equal(calls.length, 1);
    assertSameOriginGetCall(calls[0], '/api/auth/me', signal);
  });

  test('register 原样发送 Unicode 密码且不修改调用方对象', async () => {
    const input = {
      username: 'snake_user',
      password: '密码🐍e\u0301𠮷',
      ignored: '不能发送',
    };
    const before = structuredClone(input);
    const { calls, fetchImpl } = createFetchRecorder(() => jsonResponse({
      data: { user: { id: '2', username: input.username, bestScore: 0 } },
    }, { status: 201 }));
    const signal = new AbortController().signal;

    await createApiClient({ fetchImpl }).register(input, { signal });

    assert.deepEqual(input, before);
    assert.equal(calls.length, 1);
    assertSameOriginPostCall(calls[0], '/api/auth/register', {
      username: input.username,
      password: input.password,
    }, signal);
  });

  test('login 只发送用户名和密码，并透传 signal', async () => {
    const input = { username: 'trinity', password: 'not-a-real-secret', admin: true };
    const { calls, fetchImpl } = createFetchRecorder();
    const signal = new AbortController().signal;

    await createApiClient({ fetchImpl }).login(input, { signal });

    assert.equal(calls.length, 1);
    assertSameOriginPostCall(calls[0], '/api/auth/login', {
      username: input.username,
      password: input.password,
    }, signal);
  });

  test('logout 始终发送空 JSON 对象，并透传 signal', async () => {
    const { calls, fetchImpl } = createFetchRecorder();
    const signal = new AbortController().signal;

    await createApiClient({ fetchImpl }).logout({ signal });

    assert.equal(calls.length, 1);
    assertSameOriginPostCall(calls[0], '/api/auth/logout', {}, signal);
  });

  test('submitScore 只发送 score 与 durationMs，不泄露 outcome 或多余键', async () => {
    const input = {
      score: 120,
      durationMs: 2_400,
      outcome: 'collision',
      username: '不能发送',
    };
    const before = { ...input };
    const { calls, fetchImpl } = createFetchRecorder();
    const signal = new AbortController().signal;

    await createApiClient({ fetchImpl }).submitScore(input, { signal });

    assert.deepEqual(input, before);
    assert.equal(calls.length, 1);
    assertSameOriginPostCall(calls[0], '/api/scores', {
      score: input.score,
      durationMs: input.durationMs,
    }, signal);
  });

  test('getLeaderboard 发送不带写请求头的同源 GET，并透传 signal', async () => {
    const data = Object.freeze({ leaderboard: [], me: null });
    const { calls, fetchImpl } = createFetchRecorder(() => jsonResponse({ data }));
    const signal = new AbortController().signal;

    const actual = await createApiClient({ fetchImpl }).getLeaderboard({ signal });

    assert.deepEqual(actual, data);
    assert.equal(calls.length, 1);
    assertSameOriginGetCall(calls[0], '/api/leaderboard', signal);
  });

  test('所有方法都从 2xx data envelope 返回 data，204 返回 null', async () => {
    const payloads = [
      { method: 'getCurrentUser', args: [], value: { user: null } },
      { method: 'register', args: [{ username: 'u', password: 'p' }], value: { user: { id: '1' } } },
      { method: 'login', args: [{ username: 'u', password: 'p' }], value: { user: { id: '1' } } },
      { method: 'submitScore', args: [{ score: 10, durationMs: 70 }], value: { bestScore: 10 } },
      { method: 'getLeaderboard', args: [], value: { leaderboard: [] } },
    ];

    for (const { method, args, value } of payloads) {
      const client = createApiClient({
        fetchImpl: async () => jsonResponse({ data: value }, { status: 200 }),
      });
      assert.deepEqual(await client[method](...args), value, method);
    }

    const client = createApiClient({ fetchImpl: async () => emptyResponse() });
    assert.equal(await client.logout(), null);
  });

  test('标准错误 envelope 转换为不保留原始响应的稳定 ApiError', async () => {
    const client = createApiClient({ fetchImpl: async () => jsonResponse({
      error: {
        code: 'INVALID_CREDENTIALS',
        message: '用户名或密码错误',
        requestId: 'request-17',
      },
    }, { status: 401 }) });

    await assert.rejects(
      client.login({ username: 'neo', password: 'wrong' }),
      (error) => {
        assert.equal(error instanceof ApiError, true);
        assert.equal(error.name, 'ApiError');
        assert.equal(error.message, '用户名或密码错误');
        assert.equal(error.status, 401);
        assert.equal(error.code, 'INVALID_CREDENTIALS');
        assert.equal(error.requestId, 'request-17');
        assert.equal(error.retryAfterSeconds, null);
        assert.equal(Object.hasOwn(error, 'response'), false);
        assert.equal(Object.hasOwn(error, 'body'), false);
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  test('429 只把可靠的 Retry-After 秒数暴露为整数', async () => {
    for (const [header, expected] of [
      ['0', 0],
      ['60', 60],
      ['001', 1],
      ['', null],
      ['1.5', null],
      ['10seconds', null],
      ['-1', null],
      ['999999999999999999999', null],
      ['Wed, 21 Oct 2015 07:28:00 GMT', null],
      [null, null],
    ]) {
      const headers = header === null ? {} : { 'Retry-After': header };
      const client = createApiClient({ fetchImpl: async () => jsonResponse({
        error: {
          code: 'RATE_LIMITED',
          message: '请求过于频繁，请稍后再试',
          requestId: 'limited-request',
        },
      }, { status: 429, headers }) });

      await assert.rejects(
        client.submitScore({ score: 10, durationMs: 70 }),
        (error) => error instanceof ApiError && error.retryAfterSeconds === expected,
        String(header),
      );
    }
  });

  test('成功响应不是 JSON 时抛 PROTOCOL_ERROR 且不暴露正文', async () => {
    const client = createApiClient({ fetchImpl: async () => new Response(
      '<html>proxy failure: secret-token</html>',
      { status: 200, headers: { 'Content-Type': 'text/html' } },
    ) });

    await assert.rejects(client.getCurrentUser(), (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 200);
      assert.equal(error.code, 'PROTOCOL_ERROR');
      assert.equal(error.message, '服务器返回了无法识别的数据');
      assert.equal(error.requestId, null);
      assert.doesNotMatch(String(error), /secret-token|<html>/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  test('成功响应缺少 data envelope 时抛 PROTOCOL_ERROR', async () => {
    for (const body of [null, [], {}, { result: null }, { dataFromServer: 1 }]) {
      const client = createApiClient({ fetchImpl: async () => jsonResponse(body) });
      await assert.rejects(
        client.getLeaderboard(),
        (error) => error instanceof ApiError
          && error.status === 200
          && error.code === 'PROTOCOL_ERROR',
      );
    }
  });

  test('错误响应为非法 JSON 时抛不泄露 HTML 的稳定 HTTP_ERROR', async () => {
    const client = createApiClient({ fetchImpl: async () => new Response(
      '<html>upstream secret-token</html>',
      { status: 502, headers: { 'Content-Type': 'text/html' } },
    ) });

    await assert.rejects(client.getLeaderboard(), (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 502);
      assert.equal(error.code, 'HTTP_ERROR');
      assert.equal(error.message, '请求失败');
      assert.equal(error.requestId, null);
      assert.equal(error.retryAfterSeconds, null);
      assert.doesNotMatch(String(error), /secret-token|<html>/u);
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  test('错误响应缺少标准 error envelope 时抛稳定 HTTP_ERROR', async () => {
    for (const body of [
      null,
      [],
      {},
      { error: null },
      { error: { code: '', message: 'bad', requestId: 'r' } },
      { error: { code: 'BAD', message: '', requestId: 'r' } },
      { error: { code: 'BAD', message: 'bad' } },
      { error: { code: 'BAD', message: 'bad', requestId: 7 } },
    ]) {
      const client = createApiClient({ fetchImpl: async () => jsonResponse(body, { status: 500 }) });
      await assert.rejects(
        client.getCurrentUser(),
        (error) => error instanceof ApiError
          && error.status === 500
          && error.code === 'HTTP_ERROR'
          && error.message === '请求失败'
          && error.requestId === null,
      );
    }
  });

  test('网络错误包装为 NETWORK_ERROR 并保留 cause', async () => {
    const cause = new TypeError('fetch failed with private network details');
    const client = createApiClient({ fetchImpl: async () => { throw cause; } });

    await assert.rejects(client.getCurrentUser(), (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, null);
      assert.equal(error.code, 'NETWORK_ERROR');
      assert.equal(error.message, '网络连接失败，请检查网络后重试');
      assert.equal(error.requestId, null);
      assert.equal(error.retryAfterSeconds, null);
      assert.equal(error.cause, cause);
      return true;
    });
  });

  test('AbortError 保持原对象传播，不伪装成网络错误', async () => {
    const abortError = new DOMException('This operation was aborted', 'AbortError');
    const client = createApiClient({ fetchImpl: async () => { throw abortError; } });

    await assert.rejects(
      client.getLeaderboard({ signal: new AbortController().signal }),
      (error) => error === abortError && error.name === 'AbortError',
    );
  });

  test('每次 POST 失败都只调用一次 fetch，绝不自动重试', async () => {
    const cases = [
      ['register', [{ username: 'u', password: 'p' }]],
      ['login', [{ username: 'u', password: 'p' }]],
      ['logout', []],
      ['submitScore', [{ score: 10, durationMs: 70 }]],
    ];

    for (const [method, args] of cases) {
      let attempts = 0;
      const cause = new TypeError('offline');
      const client = createApiClient({
        fetchImpl: async () => {
          attempts += 1;
          throw cause;
        },
      });

      await assert.rejects(
        client[method](...args),
        (error) => error instanceof ApiError && error.code === 'NETWORK_ERROR',
      );
      assert.equal(attempts, 1, method);
    }
  });
});
