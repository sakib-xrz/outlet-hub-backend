import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { validate } from '@/middlewares/validate.js';
import type { MenuItemController } from '@/modules/menu-items/menu-item.controller.js';
import {
  createMenuItemSchema,
  menuItemListQuerySchema,
  menuItemParamsSchema,
  updateMenuItemSchema,
  updateMenuItemStatusSchema,
} from '@/modules/menu-items/menu-item.validation.js';

export function createMenuItemRouter(
  controller: MenuItemController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();
  const withParams = { params: menuItemParamsSchema };

  router.use(requireAuth, authorize(Role.HQ_ADMIN));
  router.get('/', validate({ query: menuItemListQuerySchema }), controller.list);
  router.post('/', validate({ body: createMenuItemSchema }), controller.create);
  router.get('/:menuItemId', validate(withParams), controller.get);
  router.patch(
    '/:menuItemId',
    validate({ ...withParams, body: updateMenuItemSchema }),
    controller.update,
  );
  router.patch(
    '/:menuItemId/status',
    validate({ ...withParams, body: updateMenuItemStatusSchema }),
    controller.setStatus,
  );
  return router;
}
