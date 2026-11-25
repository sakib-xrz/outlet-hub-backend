import { NotFoundError } from '@/common/errors/app-error.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';
import type { ReportRepository } from '@/modules/reports/report.repository.js';
import type {
  BusinessSummary,
  DateRange,
  OutletRevenue,
  ReportOutlet,
  ReportRangeQuery,
  RevenueByOutletQuery,
  TopSellingItem,
} from '@/modules/reports/report.types.js';

export type ReportStore = Pick<ReportRepository, 'summary' | 'revenueByOutlet' | 'topSellingItems'>;

export function toDateRange(query: ReportRangeQuery): DateRange {
  return query.from && query.to ? { from: new Date(query.from), to: new Date(query.to) } : null;
}

export class ReportService {
  public constructor(private readonly repository: ReportStore) {}

  public summary(query: ReportRangeQuery): Promise<BusinessSummary> {
    return this.repository.summary(toDateRange(query));
  }

  public async revenueByOutlet(query: RevenueByOutletQuery): Promise<Paginated<OutletRevenue>> {
    const { items, total } = await this.repository.revenueByOutlet(toDateRange(query), query);
    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  public async topSellingItems(
    outletId: string,
    query: ReportRangeQuery,
  ): Promise<{ outlet: ReportOutlet; items: TopSellingItem[] }> {
    const result = await this.repository.topSellingItems(outletId, toDateRange(query));
    if (!result) throw new NotFoundError('Outlet not found');
    return result;
  }
}
