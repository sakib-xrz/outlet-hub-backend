import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '@/config/env.js';
import type { AuthController } from '@/modules/auth/auth.controller.js';
import type { TokenService } from '@/modules/auth/token.service.js';
import { loginSchema } from '@/modules/auth/auth.validation.js';
import { authenticate } from '@/middlewares/authenticate.js';
import { requireTrustedOrigin } from '@/middlewares/trusted-origin.js';
import { validate } from '@/middlewares/validate.js';

export function createAuthRouter(
  controller: AuthController,
  tokens: TokenService,
  config: AppConfig,
): Router {
  const router = Router();
  const trustedOrigin = requireTrustedOrigin(config.ALLOWED_ORIGINS);
  const authLimiter = rateLimit({
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (request, response) => {
      response.status(429).json({
        success: false,
        message: 'Too many authentication attempts',
        code: 'RATE_LIMITED',
        requestId: request.id,
      });
    },
  });

  router.post(
    '/login',
    trustedOrigin,
    authLimiter,
    validate({ body: loginSchema }),
    controller.login,
  );
  router.post('/refresh', trustedOrigin, authLimiter, controller.refresh);
  router.post('/logout', trustedOrigin, controller.logout);
  router.get('/me', authenticate(tokens), controller.me);
  return router;
}
