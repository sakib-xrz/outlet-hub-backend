import { type RequestHandler, Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { AppConfig } from '@/config/env.js';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { validate } from '@/middlewares/validate.js';
import type { StaffController } from '@/modules/staff/staff.controller.js';
import {
  createStaffSchema,
  replaceStaffOutletsSchema,
  resetStaffPasswordSchema,
  staffListQuerySchema,
  staffParamsSchema,
  updateStaffSchema,
  updateStaffStatusSchema,
} from '@/modules/staff/staff.validation.js';

export function createStaffRouter(
  controller: StaffController,
  requireAuth: RequestHandler,
  config: AppConfig,
): Router {
  const router = Router();
  const passwordResetLimiter = rateLimit({
    windowMs: config.AUTH_RATE_LIMIT_WINDOW_MS,
    limit: config.AUTH_RATE_LIMIT_MAX,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (request) => `password-reset:${request.user?.id ?? 'anonymous'}`,
    handler: (request, response) => {
      response.status(429).json({
        success: false,
        message: 'Too many password resets. Try again later.',
        code: 'RATE_LIMITED',
        requestId: request.id,
      });
    },
  });
  const withParams = { params: staffParamsSchema };

  router.use(requireAuth, authorize(Role.HQ_ADMIN));
  router.get('/', validate({ query: staffListQuerySchema }), controller.list);
  router.post('/', validate({ body: createStaffSchema }), controller.create);
  router.get('/:staffId', validate(withParams), controller.get);
  router.patch(
    '/:staffId',
    validate({ ...withParams, body: updateStaffSchema }),
    controller.update,
  );
  router.patch(
    '/:staffId/status',
    validate({ ...withParams, body: updateStaffStatusSchema }),
    controller.setStatus,
  );
  router.put(
    '/:staffId/outlets',
    validate({ ...withParams, body: replaceStaffOutletsSchema }),
    controller.replaceOutlets,
  );
  router.patch(
    '/:staffId/password',
    passwordResetLimiter,
    validate({ ...withParams, body: resetStaffPasswordSchema }),
    controller.resetPassword,
  );
  return router;
}
