import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import swaggerUi from 'swagger-ui-express';
import type { Logger } from 'pino';
import { AuthorizationError } from '@/common/errors/app-error.js';
import type { AppConfig } from '@/config/env.js';
import type { DatabaseClient } from '@/database/client.js';
import { openApiDocument } from '@/docs/openapi.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { notFound } from '@/middlewares/not-found.js';
import { requestId } from '@/middlewares/request-id.js';
import { createApiRouter } from '@/routes/index.js';

type AppDependencies = { config: AppConfig; database: DatabaseClient; logger: Logger };

export function createApp({ config, database, logger }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (request) => request.id,
      customProps: (request) => ({ requestId: request.id }),
      customLogLevel: (_request, response, error) => {
        if (error || response.statusCode >= 500) return 'error';
        if (response.statusCode >= 400) return 'warn';
        return 'info';
      },
      customSuccessMessage: (request, response) =>
        `${request.method} completed with ${response.statusCode}`,
      customErrorMessage: (request, response) =>
        `${request.method} failed with ${response.statusCode}`,
    }),
  );
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.use(
    cors({
      credentials: true,
      methods: ['GET', 'POST'],
      allowedHeaders: ['authorization', 'content-type', 'x-request-id'],
      origin: (origin, callback) => {
        if (!origin || config.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        return callback(new AuthorizationError('Origin is not allowed'));
      },
    }),
  );
  app.use(
    rateLimit({
      windowMs: config.GLOBAL_RATE_LIMIT_WINDOW_MS,
      limit: config.GLOBAL_RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (request, response) => {
        response.status(429).json({
          success: false,
          message: 'Too many requests',
          code: 'RATE_LIMITED',
          requestId: request.id,
        });
      },
    }),
  );
  app.use(express.json({ limit: config.BODY_LIMIT, strict: true }));
  app.use(express.urlencoded({ extended: false, limit: config.BODY_LIMIT }));
  app.use(cookieParser());

  app.get('/openapi.json', (_request, response) => response.json(openApiDocument));
  if (config.SWAGGER_ENABLED && config.NODE_ENV !== 'production') {
    app.use(
      '/docs',
      helmet.contentSecurityPolicy({
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
        },
      }),
      swaggerUi.serve,
      swaggerUi.setup(openApiDocument, { explorer: false }),
    );
  }
  app.use('/api/v1', createApiRouter(database, config));
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
