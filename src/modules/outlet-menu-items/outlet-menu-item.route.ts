import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { requireOutletAccess } from '@/middlewares/outlet-access.js';
import { validate } from '@/middlewares/validate.js';
import type { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import type { OutletMenuItemController } from '@/modules/outlet-menu-items/outlet-menu-item.controller.js';
import {
  assignMenuItemSchema,
  outletMenuItemParamsSchema,
  outletMenuListQuerySchema,
  outletMenuParamsSchema,
  updateAssignmentStatusSchema,
  updateOverridePriceSchema,
} from '@/modules/outlet-menu-items/outlet-menu-item.validation.js';

export function createOutletMenuItemRouter(
  controller: OutletMenuItemController,
  requireAuth: RequestHandler,
  access: Pick<OutletAccessService, 'assertCanAccessOutlet'>,
): Router {
  const router = Router({ mergeParams: true });
  const hqAdminOnly = authorize(Role.HQ_ADMIN);
  const itemParams = { params: outletMenuItemParamsSchema };

  router.use(requireAuth);
  router.get(
    '/',
    requireOutletAccess(access),
    validate({ query: outletMenuListQuerySchema }),
    controller.list,
  );
  router.post(
    '/',
    hqAdminOnly,
    validate({ params: outletMenuParamsSchema, body: assignMenuItemSchema }),
    controller.assign,
  );
  router.get('/:menuItemId', requireOutletAccess(access), validate(itemParams), controller.get);
  router.patch(
    '/:menuItemId/price',
    hqAdminOnly,
    validate({ ...itemParams, body: updateOverridePriceSchema }),
    controller.setPrice,
  );
  router.patch(
    '/:menuItemId/status',
    hqAdminOnly,
    validate({ ...itemParams, body: updateAssignmentStatusSchema }),
    controller.setStatus,
  );
  return router;
}
