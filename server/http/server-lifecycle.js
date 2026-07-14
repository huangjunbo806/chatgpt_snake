function safeError(logger, entry) {
  try {
    const error = logger?.error;
    if (typeof error === 'function') {
      error.call(logger, entry);
    }
  } catch {
    // 日志系统故障不能改变关闭结果。
  }
}

export function listenForConnections({ app, port, host } = {}) {
  return new Promise((resolve, reject) => {
    let server;
    let settled = false;

    function cleanup() {
      server?.removeListener?.('error', onError);
    }

    function succeed() {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(server);
    }

    function onListening() {
      // app.listen 的真实回调是异步的；排入微任务也兼容同步测试替身。
      queueMicrotask(succeed);
    }

    function onError(error) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    }

    try {
      server = app.listen(port, host, onListening);
      if (typeof server?.once !== 'function') {
        throw new Error('app.listen 必须返回 HTTP server');
      }
      server.once('error', onError);
    } catch (error) {
      onError(error);
    }
  });
}

function closeHttpServer(server) {
  if (server.listening === false) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    try {
      server.close((error) => {
        if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
          resolve();
          return;
        }
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    } catch (error) {
      if (error?.code === 'ERR_SERVER_NOT_RUNNING') {
        resolve();
        return;
      }
      reject(error);
    }
  });
}

async function closeResources(server, pool) {
  const errors = [];

  try {
    await closeHttpServer(server);
  } catch (error) {
    errors.push(error);
  }

  try {
    await pool.end();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, 'HTTP 服务与数据库连接池关闭失败');
  }
}

export function createServerLifecycle({
  server,
  pool,
  processLike = process,
  logger = console,
} = {}) {
  if (!server || typeof server.close !== 'function') {
    throw new Error('createServerLifecycle 需要 HTTP server');
  }
  if (!pool || typeof pool.end !== 'function') {
    throw new Error('createServerLifecycle 需要可结束的 pool');
  }

  let signalHandlersInstalled = false;
  let signalShutdownStarted = false;
  let closePromise;

  function removeSignalHandlers() {
    if (!signalHandlersInstalled) {
      return;
    }
    processLike.removeListener('SIGINT', handleSignal);
    processLike.removeListener('SIGTERM', handleSignal);
    signalHandlersInstalled = false;
  }

  function close() {
    if (closePromise) {
      return closePromise;
    }

    removeSignalHandlers();
    closePromise = closeResources(server, pool);
    return closePromise;
  }

  function handleSignal() {
    if (signalShutdownStarted) {
      return;
    }
    signalShutdownStarted = true;
    close().catch(() => {
      safeError(logger, { event: 'server_shutdown_failed' });
      try {
        processLike.exitCode = 1;
      } catch {
        // 测试替身或受限 process-like 可能不允许写 exitCode。
      }
    });
  }

  function installSignalHandlers() {
    if (signalHandlersInstalled || closePromise) {
      return;
    }

    try {
      processLike.once('SIGINT', handleSignal);
      processLike.once('SIGTERM', handleSignal);
      signalHandlersInstalled = true;
    } catch (error) {
      // 注册是一个整体；部分成功时立即回滚，且不让回滚异常覆盖原错误。
      try {
        processLike.removeListener('SIGINT', handleSignal);
      } catch {
        // 受限 process-like 可能不支持移除监听器。
      }
      try {
        processLike.removeListener('SIGTERM', handleSignal);
      } catch {
        // 受限 process-like 可能不支持移除监听器。
      }
      throw error;
    }
  }

  return Object.freeze({ close, installSignalHandlers });
}
