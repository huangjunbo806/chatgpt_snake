export class AppError extends Error {
  constructor({ status, code, message, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.isAppError = true;
  }
}

function toPublicError(error) {
  if (error instanceof AppError) {
    return error;
  }

  if (error?.type === 'entity.parse.failed') {
    return new AppError({
      status: 400,
      code: 'INVALID_JSON',
      message: '请求体必须是有效的 JSON',
      cause: error,
    });
  }

  if (error?.type === 'entity.too.large') {
    return new AppError({
      status: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: '请求体不能超过 16 KiB',
      cause: error,
    });
  }

  if (error?.type === 'charset.unsupported' || error?.type === 'encoding.unsupported') {
    return new AppError({
      status: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: '不支持请求体的字符集或内容编码',
      cause: error,
    });
  }

  return new AppError({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: '服务器内部错误',
    cause: error,
  });
}

function logServerError(logger, publicError, req) {
  if (publicError.status < 500 || typeof logger?.error !== 'function') {
    return;
  }

  const context = {
    event: 'http_request_failed',
    requestId: req.requestId,
    method: req.method,
    path: req.path,
    errorType: publicError.code,
  };

  try {
    logger.error(context, '请求处理失败');
  } catch {
    // 日志系统故障不能改变公开 HTTP 响应。
  }
}

export function createErrorHandler({ logger = console } = {}) {
  return function errorHandler(error, req, res, next) {
    if (res.headersSent) {
      next(error);
      return;
    }

    const publicError = toPublicError(error);
    logServerError(logger, publicError, req);

    res.status(publicError.status).json({
      error: {
        code: publicError.code,
        message: publicError.message,
        requestId: req.requestId,
      },
    });
  };
}
