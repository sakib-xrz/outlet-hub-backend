import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { requireOutletAccess } from '@/middlewares/outlet-access.js';
import { validate } from '@/middlewares/validate.js';
import type { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import type { OutletController } from '@/modules/outlets/outlet.controller.js';
import {
  createOutletSchema,
  outletListQuerySchema,
  outletParamsSchema,
  updateOutletSchema,
  updateOutletStatusSchema,
} from '@/modules/outlets/outlet.validation.js';

export function createOutletRouter(
  controller: OutletController,
  requireAuth: RequestHandler,
  access: Pick<OutletAccessService, 'assertCanAccessOutlet'>,
): Router {
  const router = Router();
  const hqAdminOnly = authorize(Role.HQ_ADMIN);

  router.use(requireAuth);
  router.get('/', validate({ query: outletListQuerySchema }), controller.list);
  router.post('/', hqAdminOnly, validate({ body: createOutletSchema }), controller.create);
  router.get('/:outletId', requireOutletAccess(access), controller.get);
  router.patch(
    '/:outletId',
    hqAdminOnly,
    validate({ params: outletParamsSchema, body: updateOutletSchema }),
    controller.update,
  );
  router.patch(
    '/:outletId/status',
    hqAdminOnly,
    validate({ params: outletParamsSchema, body: updateOutletStatusSchema }),
    controller.setStatus,
  );
  return router;
}
