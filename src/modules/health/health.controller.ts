import type { Request, Response } from 'express';
import type { AppConfig } from '@/config/env.js';
import { success } from '@/common/types/http.js';
import { withTimeout } from '@/common/utils/async.js';
import type { DatabaseClient } from '@/database/client.js';

export class HealthController {
  public constructor(
    private readonly database: DatabaseClient,
    private readonly config: AppConfig,
  ) {}

  public live = (_request: Request, response: Response): void => {
    response.json(success({ status: 'up' }));
  };

  public ready = async (request: Request, response: Response): Promise<void> => {
    try {
      await withTimeout(
        this.database.$queryRaw`SELECT 1`,
        this.config.DATABASE_HEALTH_TIMEOUT_MS,
        'Database health check timed out',
      );
      response.json(success({ status: 'ready', database: 'up' }));
    } catch {
      response.status(503).json({
        success: false,
        message: 'Service is not ready',
        code: 'SERVICE_UNAVAILABLE',
        requestId: request.id,
      });
    }
  };
}
