import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, test } from 'node:test';
import { inspect } from 'node:util';

import {
  createServerLifecycle,
  listenForConnections,
} from '../../server/http/server-lifecycle.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createProcessLike() {
  const emitter = new EventEmitter();
  emitter.exitCode = undefined;
  return emitter;
}

function createLogger() {
  const entries = [];
  return {
    entries,
    error(...args) {
      entries.push(args);
    },
  };
}

describe('listenForConnections', () => {
  test('按 host/port 监听，成功后移除临时 error listener 并返回 server', async () => {
    const server = new EventEmitter();
    server.listening = true;
    const calls = [];
    const app = {
      listen(port, host, callback) {
        calls.push({ port, host });
        queueMicrotask(callback);
        return server;
      },
    };

    const result = await listenForConnections({ app, port: 3000, host: '127.0.0.1' });

    assert.equal(result, server);
    assert.deepEqual(calls, [{ port: 3000, host: '127.0.0.1' }]);
    assert.equal(server.listenerCount('error'), 0);
  });

  test('保留同步 listen 异常身份', async () => {
    const listenError = new Error('listen-sync-secret');

    await assert.rejects(
      listenForConnections({
        app: {
          listen() {
            throw listenError;
          },
        },
        port: 3000,
        host: '127.0.0.1',
      }),
      (error) => error === listenError,
    );
  });

  test('保留监听 error 事件身份并清理临时 listener', async () => {
    const server = new EventEmitter();
    const listenError = new Error('EADDRINUSE');
    const app = {
      listen() {
        queueMicrotask(() => server.emit('error', listenError));
        return server;
      },
    };

    await assert.rejects(
      listenForConnections({ app, port: 3000, host: '127.0.0.1' }),
      (error) => error === listenError,
    );
    assert.equal(server.listenerCount('error'), 0);
  });
});

describe('createServerLifecycle', () => {
  test('close 是幂等的非 async 函数，并发及重复调用严格返回同一个 Promise', async () => {
    const httpClose = deferred();
    const poolClose = deferred();
    const calls = [];
    const server = {
      listening: true,
      close(callback) {
        calls.push('http:start');
        httpClose.promise.then(() => {
          this.listening = false;
          calls.push('http:end');
          callback();
        });
      },
    };
    const pool = {
      async end() {
        calls.push('pool:start');
        await poolClose.promise;
        calls.push('pool:end');
      },
    };
    const processLike = createProcessLike();
    const lifecycle = createServerLifecycle({ server, pool, processLike });
    lifecycle.installSignalHandlers();

    const first = lifecycle.close();
    const second = lifecycle.close();

    assert.equal(Object.isFrozen(lifecycle), true);
    assert.equal(first, second);
    assert.equal(first instanceof Promise, true);
    assert.deepEqual(calls, ['http:start']);
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);

    httpClose.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ['http:start', 'http:end', 'pool:start']);
    poolClose.resolve();
    await first;

    assert.deepEqual(calls, ['http:start', 'http:end', 'pool:start', 'pool:end']);
    assert.equal(lifecycle.close(), first);
  });

  test('尚未监听或已经关闭的 server 可安全 close，仍结束 pool', async () => {
    let serverCloseCalls = 0;
    let poolEndCalls = 0;
    const lifecycle = createServerLifecycle({
      server: {
        listening: false,
        close() {
          serverCloseCalls += 1;
          throw new Error('不应调用');
        },
      },
      pool: {
        async end() {
          poolEndCalls += 1;
        },
      },
      processLike: createProcessLike(),
    });

    await lifecycle.close();

    assert.equal(serverCloseCalls, 0);
    assert.equal(poolEndCalls, 1);
  });

  test('HTTP 关闭失败后仍结束 pool，并保留单个错误身份', async () => {
    const httpError = new Error('http-close-secret');
    let poolEndCalls = 0;
    const lifecycle = createServerLifecycle({
      server: {
        listening: true,
        close(callback) {
          callback(httpError);
        },
      },
      pool: {
        async end() {
          poolEndCalls += 1;
        },
      },
      processLike: createProcessLike(),
    });

    await assert.rejects(lifecycle.close(), (error) => error === httpError);
    assert.equal(poolEndCalls, 1);
  });

  test('HTTP 与 pool 都关闭失败时抛 AggregateError 并保留两个 cause', async () => {
    const httpError = new Error('http-close-secret');
    const poolError = new Error('pool-close-secret');
    const lifecycle = createServerLifecycle({
      server: {
        listening: true,
        close(callback) {
          callback(httpError);
        },
      },
      pool: {
        async end() {
          throw poolError;
        },
      },
      processLike: createProcessLike(),
    });

    await assert.rejects(lifecycle.close(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(error.errors, [httpError, poolError]);
      assert.equal(error.message, 'HTTP 服务与数据库连接池关闭失败');
      return true;
    });
  });

  test('SIGINT 与 SIGTERM 触发同一个 close，成功时不直接退出或修改 exitCode', async () => {
    const processLike = createProcessLike();
    let serverCloseCalls = 0;
    let poolEndCalls = 0;
    const lifecycle = createServerLifecycle({
      server: {
        listening: true,
        close(callback) {
          serverCloseCalls += 1;
          this.listening = false;
          callback();
        },
      },
      pool: {
        async end() {
          poolEndCalls += 1;
        },
      },
      processLike,
    });

    lifecycle.installSignalHandlers();
    lifecycle.installSignalHandlers();
    assert.equal(processLike.listenerCount('SIGINT'), 1);
    assert.equal(processLike.listenerCount('SIGTERM'), 1);

    processLike.emit('SIGINT');
    processLike.emit('SIGTERM');
    await lifecycle.close();

    assert.equal(serverCloseCalls, 1);
    assert.equal(poolEndCalls, 1);
    assert.equal(processLike.exitCode, undefined);
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);
  });

  test('信号关闭失败时只记录受控事件并设置 exitCode=1', async () => {
    const processLike = createProcessLike();
    const logger = createLogger();
    const closeError = new Error('shutdown-password=secret');
    let poolEndCalls = 0;
    const lifecycle = createServerLifecycle({
      server: {
        listening: true,
        close(callback) {
          callback(closeError);
        },
      },
      pool: {
        async end() {
          poolEndCalls += 1;
        },
      },
      processLike,
      logger,
    });

    lifecycle.installSignalHandlers();
    processLike.emit('SIGTERM');
    await assert.rejects(lifecycle.close(), (error) => error === closeError);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(poolEndCalls, 1);
    assert.equal(processLike.exitCode, 1);
    assert.deepEqual(logger.entries, [[{ event: 'server_shutdown_failed' }]]);
    assert.doesNotMatch(inspect(logger.entries), /password=|secret/iu);
  });

  test('close 之前未安装监听器，或 close 后再安装，都不会留下 signal listener', async () => {
    const processLike = createProcessLike();
    const lifecycle = createServerLifecycle({
      server: { listening: false, close() {} },
      pool: { async end() {} },
      processLike,
    });

    await lifecycle.close();
    lifecycle.installSignalHandlers();

    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);
  });

  test('第二个信号监听器安装失败时回滚已经安装的监听器', async () => {
    const processLike = createProcessLike();
    const installError = new Error('signal-install-secret');
    const eventEmitterOnce = processLike.once;
    processLike.once = function once(eventName, listener) {
      if (eventName === 'SIGTERM') {
        throw installError;
      }
      return eventEmitterOnce.call(this, eventName, listener);
    };
    let poolEndCalls = 0;
    const lifecycle = createServerLifecycle({
      server: { listening: false, close() {} },
      pool: {
        async end() {
          poolEndCalls += 1;
        },
      },
      processLike,
    });

    assert.throws(
      () => lifecycle.installSignalHandlers(),
      (error) => error === installError,
    );
    assert.equal(processLike.listenerCount('SIGINT'), 0);
    assert.equal(processLike.listenerCount('SIGTERM'), 0);

    await lifecycle.close();
    assert.equal(poolEndCalls, 1);
  });
});
