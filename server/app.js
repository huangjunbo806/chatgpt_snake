import express from 'express';
import helmet from 'helmet';

import { AppError, createErrorHandler } from './errors.js';
import { createRequestContext } from './middleware/request-context.js';
import { createSameOriginWrite } from './middleware/same-origin-write.js';

const noopSession = (req, res, next) => next();

function helmetOptions(nodeEnv) {
  if (nodeEnv === 'production') {
    return {};
  }

  return {
    contentSecurityPolicy: {
      directives: {
        'upgrade-insecure-requests': null,
      },
    },
  };
}

export function createApp({
  config,
  healthCheck = async () => true,
  sessionMiddleware = noopSession,
  routers = [],
  logger = console,
  requestIdFactory,
} = {}) {
  if (!config) {
    throw new Error('createApp 需要 config');
  }

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy ?? 0);
  app.use(createRequestContext({ requestIdFactory }));
  app.use(helmet(helmetOptions(config.nodeEnv)));

  app.get('/healthz', async (req, res, next) => {
    try {
      if (await healthCheck()) {
        res.json({ data: { status: 'ok' } });
        return;
      }

      next(new AppError({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂不可用',
      }));
    } catch (error) {
      next(new AppError({
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        message: '服务暂不可用',
        cause: error,
      }));
    }
  });

  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api', createSameOriginWrite({ publicOrigin: config.publicOrigin }));
  app.use('/api/scores', express.json({ limit: 16 * 1024, strict: false }));
  app.use(express.json({ limit: 16 * 1024 }));
  app.use(sessionMiddleware);

  for (const { path, router } of routers) {
    app.use(path, router);
  }

  app.use('/api', (req, res, next) => {
    next(new AppError({
      status: 404,
      code: 'API_NOT_FOUND',
      message: 'API 接口不存在',
    }));
  });

  app.use(express.static(config.staticRoot));

  app.use((req, res, next) => {
    next(new AppError({
      status: 404,
      code: 'NOT_FOUND',
      message: '页面不存在',
    }));
  });

  app.use(createErrorHandler({ logger }));

  return app;
}
