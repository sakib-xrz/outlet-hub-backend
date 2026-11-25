import { Router } from 'express';
import type { AppConfig } from '@/config/env.js';
import type { DatabaseClient } from '@/database/client.js';
import { AuthController } from '@/modules/auth/auth.controller.js';
import { AuthRepository } from '@/modules/auth/auth.repository.js';
import { createAuthRouter } from '@/modules/auth/auth.route.js';
import { AuthService } from '@/modules/auth/auth.service.js';
import { TokenService } from '@/modules/auth/token.service.js';
import { authenticate } from '@/middlewares/authenticate.js';
import { OutletAccessRepository } from '@/modules/access/outlet-access.repository.js';
import { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import { OutletController } from '@/modules/outlets/outlet.controller.js';
import { OutletRepository } from '@/modules/outlets/outlet.repository.js';
import { createOutletRouter } from '@/modules/outlets/outlet.route.js';
import { OutletService } from '@/modules/outlets/outlet.service.js';
import { StaffController } from '@/modules/staff/staff.controller.js';
import { StaffRepository } from '@/modules/staff/staff.repository.js';
import { createStaffRouter } from '@/modules/staff/staff.route.js';
import { StaffService } from '@/modules/staff/staff.service.js';
import { MenuItemController } from '@/modules/menu-items/menu-item.controller.js';
import { MenuItemRepository } from '@/modules/menu-items/menu-item.repository.js';
import { createMenuItemRouter } from '@/modules/menu-items/menu-item.route.js';
import { MenuItemService } from '@/modules/menu-items/menu-item.service.js';
import { HealthController } from '@/modules/health/health.controller.js';
import { createHealthRouter } from '@/modules/health/health.route.js';

export function createApiRouter(database: DatabaseClient, config: AppConfig): Router {
  const router = Router();
  const tokens = new TokenService(config);
  const authRepository = new AuthRepository(database);
  const authService = new AuthService(authRepository, tokens, config);
  const requireAuth = authenticate(tokens, authRepository);

  router.use(
    '/auth',
    createAuthRouter(new AuthController(authService, config), requireAuth, config),
  );
  const outletAccess = new OutletAccessService(new OutletAccessRepository(database));
  const outletController = new OutletController(new OutletService(new OutletRepository(database)));

  router.use('/outlets', createOutletRouter(outletController, requireAuth, outletAccess));
  const staffController = new StaffController(new StaffService(new StaffRepository(database)));
  router.use('/staff', createStaffRouter(staffController, requireAuth, config));
  const menuItemController = new MenuItemController(
    new MenuItemService(new MenuItemRepository(database)),
  );
  router.use('/menu-items', createMenuItemRouter(menuItemController, requireAuth));
  router.use('/health', createHealthRouter(new HealthController(database, config)));
  return router;
}
