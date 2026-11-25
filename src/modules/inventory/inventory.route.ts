import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { requireOutletAccess } from '@/middlewares/outlet-access.js';
import { validate } from '@/middlewares/validate.js';
import type { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import type { InventoryController } from '@/modules/inventory/inventory.controller.js';
import {
  inventoryListQuerySchema,
  inventoryParamsSchema,
  stockAdjustmentSchema,
} from '@/modules/inventory/inventory.validation.js';

export function createInventoryRouter(
  controller: InventoryController,
  requireAuth: RequestHandler,
  access: Pick<OutletAccessService, 'assertCanAccessOutlet'>,
): Router {
  const router = Router({ mergeParams: true });

  router.use(requireAuth);
  router.get(
    '/',
    requireOutletAccess(access),
    validate({ query: inventoryListQuerySchema }),
    controller.list,
  );
  router.get(
    '/:menuItemId',
    requireOutletAccess(access),
    validate({ params: inventoryParamsSchema }),
    controller.get,
  );
  router.patch(
    '/:menuItemId/adjust',
    authorize(Role.HQ_ADMIN),
    validate({ params: inventoryParamsSchema, body: stockAdjustmentSchema }),
    controller.adjust,
  );
  return router;
}
