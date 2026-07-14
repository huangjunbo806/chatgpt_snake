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

export async function establishLoginSession(req, userId) {
  await regenerateSession(req);
  req.session.userId = String(userId);
  await saveSession(req);
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
