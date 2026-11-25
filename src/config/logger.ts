import pino, { type Logger } from 'pino';
import type { AppConfig } from '@/config/env.js';

const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  'req.body',
  '*.passwordHash',
  '*.accessToken',
  '*.refreshToken',
  '*.token',
  'DATABASE_URL',
  'JWT_SECRET',
];

export function createLogger(config: AppConfig): Logger {
  return pino({
    level: config.LOG_LEVEL,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    base: { service: 'outlet-hub-backend', environment: config.NODE_ENV },
    ...(config.LOG_PRETTY && config.NODE_ENV !== 'production'
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:standard' },
          },
        }
      : {}),
  });
}
