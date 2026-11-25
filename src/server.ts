import '@/config/load-env.js';
import type { Server } from 'node:http';
import { createApp } from '@/app.js';
import { loadConfig } from '@/config/env.js';
import { createLogger } from '@/config/logger.js';
import { createPrismaClient } from '@/database/client.js';

const config = loadConfig();
const logger = createLogger(config);
const database = createPrismaClient(config);
let server: Server | undefined;
let shuttingDown = false;

async function shutdown(reason: string, exitCode: number): Promise<never> {
  if (shuttingDown) process.exit(exitCode);
  shuttingDown = true;
  logger.info({ reason }, 'Graceful shutdown started');

  const forceExit = setTimeout(() => {
    logger.fatal('Graceful shutdown timed out');
    server?.closeAllConnections();
    process.exit(1);
  }, config.SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  try {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    await database.$disconnect();
    clearTimeout(forceExit);
    logger.info('Graceful shutdown completed');
    process.exit(exitCode);
  } catch (error) {
    logger.fatal({ err: error }, 'Graceful shutdown failed');
    process.exit(1);
  }
}

async function main(): Promise<void> {
  await database.$connect();
  const app = createApp({ config, database, logger });
  server = app.listen(config.PORT, (error?: Error) => {
    if (error) {
      logger.fatal({ err: error }, 'HTTP server failed to start');
      void shutdown('listen-error', 1);
      return;
    }
    logger.info(
      {
        port: config.PORT,
        swaggerUrl: `http://localhost:${config.PORT}/docs`,
        healthCheckUrl: `http://localhost:${config.PORT}/api/v1/health/ready`,
      },
      'OutletHub API listening',
    );
  });
  server.requestTimeout = config.REQUEST_TIMEOUT_MS;
  server.headersTimeout = Math.min(config.REQUEST_TIMEOUT_MS + 1000, 60_000);
  server.keepAliveTimeout = 5000;
}

process.once('SIGTERM', () => void shutdown('SIGTERM', 0));
process.once('SIGINT', () => void shutdown('SIGINT', 0));
process.once('uncaughtException', (error) => {
  logger.fatal({ err: error }, 'Uncaught exception');
  void shutdown('uncaughtException', 1);
});
process.once('unhandledRejection', (error) => {
  logger.fatal({ err: error }, 'Unhandled rejection');
  void shutdown('unhandledRejection', 1);
});

main().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Application startup failed');
  void shutdown('startup-failure', 1);
});
