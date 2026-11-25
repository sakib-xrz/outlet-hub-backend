import { type RequestHandler, Router } from 'express';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { validate } from '@/middlewares/validate.js';
import type { ReportController } from '@/modules/reports/report.controller.js';
import {
  reportOutletParamsSchema,
  reportRangeQuerySchema,
  revenueByOutletQuerySchema,
} from '@/modules/reports/report.validation.js';

export function createReportRouter(
  controller: ReportController,
  requireAuth: RequestHandler,
): Router {
  const router = Router();
  router.use(requireAuth, authorize(Role.HQ_ADMIN));
  router.get('/summary', validate({ query: reportRangeQuerySchema }), controller.summary);
  router.get(
    '/revenue-by-outlet',
    validate({ query: revenueByOutletQuerySchema }),
    controller.revenueByOutlet,
  );
  router.get(
    '/outlets/:outletId/top-selling-items',
    validate({ params: reportOutletParamsSchema, query: reportRangeQuerySchema }),
    controller.topSellingItems,
  );
  return router;
}
