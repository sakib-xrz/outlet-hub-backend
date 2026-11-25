import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { requireOutletAccess } from '@/middlewares/outlet-access.js';
import { validate } from '@/middlewares/validate.js';
import type { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import type { SaleController } from '@/modules/sales/sale.controller.js';
import {
  createSaleSchema,
  saleListQuerySchema,
  saleOutletParamsSchema,
  saleParamsSchema,
  saleRequestParamsSchema,
} from '@/modules/sales/sale.validation.js';

export function createSaleRouter(
  controller: SaleController,
  requireAuth: RequestHandler,
  access: Pick<OutletAccessService, 'assertCanAccessOutlet'>,
): Router {
  const router = Router({ mergeParams: true });
  const staffOnly = authorize(Role.OUTLET_STAFF);
  const outletAccess = requireOutletAccess(access);

  router.use(requireAuth);
  router.post(
    '/',
    staffOnly,
    outletAccess,
    validate({ params: saleOutletParamsSchema, body: createSaleSchema }),
    controller.create,
  );
  router.get('/', outletAccess, validate({ query: saleListQuerySchema }), controller.list);
  router.get(
    '/by-request/:requestId',
    staffOnly,
    outletAccess,
    validate({ params: saleRequestParamsSchema }),
    controller.getByRequest,
  );
  router.get('/:saleId', outletAccess, validate({ params: saleParamsSchema }), controller.get);
  return router;
}
