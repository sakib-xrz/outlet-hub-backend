import type { Request, Response } from 'express';
import { success } from '@/common/types/http.js';
import type { ReportService } from '@/modules/reports/report.service.js';
import type { ReportRangeQuery, RevenueByOutletQuery } from '@/modules/reports/report.types.js';

export class ReportController {
  public constructor(private readonly service: ReportService) {}

  public summary = async (request: Request, response: Response): Promise<void> => {
    const summary = await this.service.summary(request.validated?.query as ReportRangeQuery);
    response.json(success(summary, 'Summary retrieved successfully'));
  };

  public revenueByOutlet = async (request: Request, response: Response): Promise<void> => {
    const result = await this.service.revenueByOutlet(
      request.validated?.query as RevenueByOutletQuery,
    );
    response.json(success(result, 'Revenue by outlet retrieved successfully'));
  };

  public topSellingItems = async (
    request: Request<{ outletId: string }>,
    response: Response,
  ): Promise<void> => {
    const result = await this.service.topSellingItems(
      request.params.outletId,
      request.validated?.query as ReportRangeQuery,
    );
    response.json(success(result, 'Top-selling items retrieved successfully'));
  };
}
