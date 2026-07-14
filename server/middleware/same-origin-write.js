import { AppError } from '../errors.js';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function createSameOriginWrite({ publicOrigin }) {
  return function sameOriginWrite(req, res, next) {
    if (!WRITE_METHODS.has(req.method)) {
      next();
      return;
    }

    if (!req.is('application/json')) {
      next(new AppError({
        status: 415,
        code: 'JSON_CONTENT_TYPE_REQUIRED',
        message: '写请求必须使用 application/json',
      }));
      return;
    }

    if (req.get('X-Docker-Snake-Request') !== '1') {
      next(new AppError({
        status: 403,
        code: 'WRITE_HEADER_REQUIRED',
        message: '写请求缺少安全标识',
      }));
      return;
    }

    if (req.get('Origin') !== publicOrigin) {
      next(new AppError({
        status: 403,
        code: 'ORIGIN_NOT_ALLOWED',
        message: '请求来源不被允许',
      }));
      return;
    }

    next();
  };
}
