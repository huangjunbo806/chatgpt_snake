import { setTimeout as delay } from 'node:timers/promises';

export const DATABASE_WAIT_ATTEMPTS = 30;
export const DATABASE_WAIT_DELAY_MS = 2_000;

function safeWarn(logger, entry) {
  try {
    const warn = logger?.warn;
    if (typeof warn === 'function') {
      warn.call(logger, entry);
    }
  } catch {
    // 日志系统故障不能改变数据库等待结果。
  }
}

function validateOptions({ healthCheck, sleep, maxAttempts, retryDelayMs }) {
  if (typeof healthCheck !== 'function') {
    throw new Error('waitForDatabase 需要 healthCheck');
  }
  if (typeof sleep !== 'function') {
    throw new Error('waitForDatabase 需要 sleep 函数');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error('maxAttempts 必须是正整数');
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new Error('retryDelayMs 必须是非负整数');
  }
}

export async function waitForDatabase({
  healthCheck,
  sleep = delay,
  logger = console,
  maxAttempts = DATABASE_WAIT_ATTEMPTS,
  retryDelayMs = DATABASE_WAIT_DELAY_MS,
} = {}) {
  validateOptions({ healthCheck, sleep, maxAttempts, retryDelayMs });

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (await healthCheck()) {
        return true;
      }
      lastError = new Error('数据库健康检查未就绪');
    } catch (error) {
      lastError = error;
    }

    const exhausted = attempt === maxAttempts;
    safeWarn(logger, {
      event: exhausted ? 'database_wait_exhausted' : 'database_wait_retry',
      attempt,
      maxAttempts,
    });
    if (!exhausted) {
      await sleep(retryDelayMs);
    }
  }

  throw new Error('数据库在启动等待期限内仍不可用', { cause: lastError });
}
