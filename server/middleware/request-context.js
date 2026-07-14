import { randomUUID } from 'node:crypto';

export function createRequestContext({ requestIdFactory = randomUUID } = {}) {
  return function requestContext(req, res, next) {
    const requestId = String(requestIdFactory());

    req.requestId = requestId;
    res.locals.requestId = requestId;
    res.set('X-Request-Id', requestId);
    next();
  };
}
