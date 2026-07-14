import session from 'express-session';

export const SESSION_COOKIE_NAME = 'app_session';
export const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function createSessionMiddleware({ store, config } = {}) {
  if (!config?.sessionSecret) {
    throw new Error('createSessionMiddleware 需要 sessionSecret 配置');
  }
  if (!(store instanceof session.Store)) {
    throw new Error('createSessionMiddleware 需要有效的 session store');
  }

  return session({
    name: SESSION_COOKIE_NAME,
    secret: config.sessionSecret,
    store,
    resave: false,
    saveUninitialized: false,
    rolling: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: SESSION_MAX_AGE_MS,
      path: '/',
    },
  });
}

function callSessionMethod(req, method) {
  return new Promise((resolve, reject) => {
    req.session[method]((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function regenerateSession(req) {
  return callSessionMethod(req, 'regenerate');
}

export function saveSession(req) {
  return callSessionMethod(req, 'save');
}

export function destroySession(req) {
  return callSessionMethod(req, 'destroy');
}

function destroyStoredSessionBestEffort(store, sessionId) {
  return new Promise((resolve) => {
    try {
      if (typeof sessionId !== 'string' || typeof store?.destroy !== 'function') {
        resolve();
        return;
      }
      store.destroy(sessionId, () => resolve());
    } catch {
      resolve();
    }
  });
}

function sessionIdOf(req) {
  return typeof req.sessionID === 'string' ? req.sessionID : null;
}

function suppressUnchangedResponseResave(req, sessionId) {
  const sessionToSave = req.session;
  const response = req.res;
  if (!sessionToSave || typeof response?.end !== 'function') {
    return;
  }

  const savedFingerprint = JSON.stringify(sessionToSave);
  const endWithSessionCommit = response.end;
  // regenerate 创建的新 Session 不会被 express-session 重新包装；显式 save 成功后，
  // 它仍会在 res.end 时再 set 一次。只对未再修改的同一 Session 应答这次冗余保存。
  response.end = function endWithoutRedundantSessionSave(...args) {
    response.end = endWithSessionCommit;
    const unchanged = req.session === sessionToSave
      && req.sessionID === sessionId
      && JSON.stringify(sessionToSave) === savedFingerprint;
    if (!unchanged) {
      return endWithSessionCommit.apply(this, args);
    }

    const saveDescriptor = Object.getOwnPropertyDescriptor(sessionToSave, 'save');
    Object.defineProperty(sessionToSave, 'save', {
      configurable: true,
      enumerable: false,
      value(callback) {
        callback?.();
        return sessionToSave;
      },
      writable: true,
    });
    try {
      return endWithSessionCommit.apply(this, args);
    } finally {
      if (saveDescriptor) {
        Object.defineProperty(sessionToSave, 'save', saveDescriptor);
      } else {
        delete sessionToSave.save;
      }
    }
  };
}

export async function establishLoginSession(req, userId) {
  const oldSessionId = sessionIdOf(req);
  const store = req.sessionStore;
  let regenerated = false;
  let generatedSessionId = null;
  try {
    await regenerateSession(req);
    regenerated = true;
    generatedSessionId = sessionIdOf(req);
    req.session.userId = String(userId);
    await saveSession(req);
    suppressUnchangedResponseResave(req, generatedSessionId);
  } catch (error) {
    const currentSessionId = sessionIdOf(req);
    // express-session 即使在旧 SID destroy 报错时也会先生成新 SID。
    const sessionIdsToDestroy = new Set(regenerated
      ? [generatedSessionId, currentSessionId]
      : [oldSessionId, currentSessionId]);
    delete req.session;
    delete req.sessionID;
    for (const sessionId of sessionIdsToDestroy) {
      await destroyStoredSessionBestEffort(store, sessionId);
    }
    throw error;
  }
}

export function clearSessionCookie(res, { secure = false } = {}) {
  res.clearCookie(SESSION_COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'lax',
    secure,
    path: '/',
  });
}

export const defaultSessionOps = Object.freeze({
  establishLoginSession,
  destroySession,
  clearSessionCookie,
});
