const PROTOCOL_ERROR_MESSAGE = '服务器返回了无法识别的数据';
const HTTP_ERROR_MESSAGE = '请求失败';
const NETWORK_ERROR_MESSAGE = '网络连接失败，请检查网络后重试';
const INVALID_JSON = Symbol('invalid-json');

export class ApiError extends Error {
  constructor({
    status = null,
    code,
    message,
    requestId = null,
    retryAfterSeconds = null,
    cause,
  }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAbortError(error) {
  return error !== null && typeof error === 'object' && error.name === 'AbortError';
}

async function readJson(response) {
  try {
    return await response.json();
  } catch {
    return INVALID_JSON;
  }
}

function parseRetryAfterSeconds(response) {
  if (response.status !== 429) {
    return null;
  }

  let value;
  try {
    value = response.headers.get('Retry-After');
  } catch {
    return null;
  }

  if (typeof value !== 'string' || !/^\d+$/u.test(value)) {
    return null;
  }

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function createProtocolError(status) {
  return new ApiError({
    status,
    code: 'PROTOCOL_ERROR',
    message: PROTOCOL_ERROR_MESSAGE,
  });
}

function createHttpError(response, body) {
  const retryAfterSeconds = parseRetryAfterSeconds(response);
  const errorData = isRecord(body) && isRecord(body.error) ? body.error : null;
  const isStandardEnvelope = errorData !== null
    && typeof errorData.code === 'string'
    && errorData.code.length > 0
    && typeof errorData.message === 'string'
    && errorData.message.length > 0
    && typeof errorData.requestId === 'string'
    && errorData.requestId.length > 0;

  if (!isStandardEnvelope) {
    return new ApiError({
      status: response.status,
      code: 'HTTP_ERROR',
      message: HTTP_ERROR_MESSAGE,
      retryAfterSeconds,
    });
  }

  return new ApiError({
    status: response.status,
    code: errorData.code,
    message: errorData.message,
    requestId: errorData.requestId,
    retryAfterSeconds,
  });
}

async function parseResponse(response) {
  if (response.status === 204) {
    return null;
  }

  const body = await readJson(response);
  const isSuccess = response.status >= 200 && response.status < 300;

  if (!isSuccess) {
    throw createHttpError(response, body);
  }

  if (!isRecord(body) || !Object.hasOwn(body, 'data')) {
    throw createProtocolError(response.status);
  }

  return body.data;
}

function createRequest(fetchImpl) {
  return async function request(url, init) {
    let response;
    try {
      response = await fetchImpl(url, init);
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }

      throw new ApiError({
        code: 'NETWORK_ERROR',
        message: NETWORK_ERROR_MESSAGE,
        cause: error,
      });
    }

    return parseResponse(response);
  };
}

function getInit(signal) {
  return {
    method: 'GET',
    credentials: 'same-origin',
    signal,
  };
}

function postInit(body, signal) {
  return {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      'X-Docker-Snake-Request': '1',
    },
    body: JSON.stringify(body),
    signal,
  };
}

export function createApiClient({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('fetchImpl 必须是函数');
  }

  const request = createRequest(fetchImpl);
  const methods = {
    getCurrentUser({ signal } = {}) {
      return request('/api/auth/me', getInit(signal));
    },
    register({ username, password }, { signal } = {}) {
      return request('/api/auth/register', postInit({ username, password }, signal));
    },
    login({ username, password }, { signal } = {}) {
      return request('/api/auth/login', postInit({ username, password }, signal));
    },
    logout({ signal } = {}) {
      return request('/api/auth/logout', postInit({}, signal));
    },
    submitScore({ score, durationMs }, { signal } = {}) {
      return request('/api/scores', postInit({ score, durationMs }, signal));
    },
    getLeaderboard({ signal } = {}) {
      return request('/api/leaderboard', getInit(signal));
    },
  };

  for (const method of Object.values(methods)) {
    Object.freeze(method);
  }
  return Object.freeze(methods);
}
