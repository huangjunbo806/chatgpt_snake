import { AppError } from '../errors.js';

export function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    next(new AppError({
      status: 401,
      code: 'AUTH_REQUIRED',
      message: '请先登录',
    }));
    return;
  }

  req.session.userId = String(req.session.userId);
  next();
}
