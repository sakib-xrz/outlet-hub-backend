import { Router } from 'express';
import type { AppConfig } from '@/config/env.js';
import type { DatabaseClient } from '@/database/client.js';
import { AuthController } from '@/modules/auth/auth.controller.js';
import { AuthRepository } from '@/modules/auth/auth.repository.js';
import { createAuthRouter } from '@/modules/auth/auth.route.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { TokenService } from '@/modules/auth/token.service.js';
import { HealthController } from '@/modules/health/health.controller.js';
import { createHealthRouter } from '@/modules/health/health.route.js';

export function createApiRouter(database: DatabaseClient, config: AppConfig): Router {
  const router = Router();
  const tokens = new TokenService(config);
  const authService = new AuthService(new AuthRepository(database), tokens, config);

  router.use('/auth', createAuthRouter(new AuthController(authService, config), tokens, config));
  router.use('/health', createHealthRouter(new HealthController(database, config)));
  return router;
}
