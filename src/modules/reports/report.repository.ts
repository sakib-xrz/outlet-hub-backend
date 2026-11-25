import type { DatabaseClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import type {
  BusinessSummary,
  DateRange,
  OutletRevenue,
  ReportOutlet,
  RevenueByOutletQuery,
  TopSellingItem,
} from '@/modules/reports/report.types.js';

export const TOP_SELLING_LIMIT = 5;

const AGGREGATE_MONEY = /^(\d+)(?:\.(\d{1,2}))?$/;
const AGGREGATE_COUNT = /^\d+$/;

export function serializeAggregateMoney(value: string): string {
  const match = AGGREGATE_MONEY.exec(value);
  if (!match) throw new Error(`Corrupted monetary aggregate from the database: ${value}`);
  return `${match[1] ?? '0'}.${(match[2] ?? '').padEnd(2, '0')}`;
}

export function serializeAggregateCount(value: string): string {
  if (!AGGREGATE_COUNT.test(value)) throw new Error(`Corrupted count aggregate: ${value}`);
  return value.replace(/^0+(?=\d)/, '');
}

function salesInRange(alias: string, range: DateRange): Prisma.Sql {
  if (!range) return Prisma.empty;
  const column = Prisma.raw(`${alias}.created_at`);
  return Prisma.sql`AND ${column} >= ${range.from} AND ${column} < ${range.to}`;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const REVENUE_ORDER: Record<RevenueByOutletQuery['sortBy'], Prisma.Sql> = {
  totalRevenue: Prisma.raw('COALESCE(agg.revenue, 0)'),
  totalSales: Prisma.raw('COALESCE(agg.sale_count, 0)'),
  code: Prisma.raw('o.code'),
};
const DIRECTION = { asc: Prisma.raw('ASC'), desc: Prisma.raw('DESC') } as const;

const READ_SNAPSHOT = { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead };

export class ReportRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async summary(range: DateRange): Promise<BusinessSummary> {
    const [sales, units, outlets] = await this.database.$transaction(
      [
        this.database.$queryRaw<{ revenue: string; sale_count: string }[]>`
          SELECT COALESCE(SUM(s.total_amount), 0)::text AS revenue,
                 COUNT(*)::text AS sale_count
          FROM sales s
          WHERE TRUE ${salesInRange('s', range)}`,
        this.database.$queryRaw<{ units: string }[]>`
          SELECT COALESCE(SUM(si.quantity), 0)::text AS units
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id AND s.outlet_id = si.outlet_id
          WHERE TRUE ${salesInRange('s', range)}`,
        this.database.$queryRaw<{ total: number; active: number }[]>`
          SELECT COUNT(*)::int AS total,
                 COUNT(*) FILTER (WHERE is_active)::int AS active
          FROM outlets`,
      ],
      READ_SNAPSHOT,
    );
    return {
      totalRevenue: serializeAggregateMoney(sales[0]?.revenue ?? '0'),
      totalSales: serializeAggregateCount(sales[0]?.sale_count ?? '0'),
      totalUnitsSold: serializeAggregateCount(units[0]?.units ?? '0'),
      totalOutlets: outlets[0]?.total ?? 0,
      activeOutlets: outlets[0]?.active ?? 0,
    };
  }

  public async revenueByOutlet(
    range: DateRange,
    query: RevenueByOutletQuery,
  ): Promise<{ items: OutletRevenue[]; total: number }> {
    const search = query.search
      ? Prisma.sql`WHERE (o.code ILIKE ${`%${escapeLike(query.search)}%`} ESCAPE '\\'
                     OR o.name ILIKE ${`%${escapeLike(query.search)}%`} ESCAPE '\\')`
      : Prisma.empty;
    const [rows, count] = await this.database.$transaction(
      [
        this.database.$queryRaw<
          {
            id: string;
            code: string;
            name: string;
            is_active: boolean;
            revenue: string;
            sale_count: string;
          }[]
        >`
          SELECT o.id, o.code, o.name, o.is_active,
                 COALESCE(agg.revenue, 0)::text AS revenue,
                 COALESCE(agg.sale_count, 0)::text AS sale_count
          FROM outlets o
          LEFT JOIN (
            SELECT s.outlet_id, SUM(s.total_amount) AS revenue, COUNT(*) AS sale_count
            FROM sales s
            WHERE TRUE ${salesInRange('s', range)}
            GROUP BY s.outlet_id
          ) agg ON agg.outlet_id = o.id
          ${search}
          ORDER BY ${REVENUE_ORDER[query.sortBy]} ${DIRECTION[query.sortOrder]}, o.id ASC
          LIMIT ${query.limit} OFFSET ${(query.page - 1) * query.limit}`,
        this.database.$queryRaw<{ total: number }[]>`
          SELECT COUNT(*)::int AS total FROM outlets o ${search}`,
      ],
      READ_SNAPSHOT,
    );
    return {
      items: rows.map((row) => ({
        outletId: row.id,
        outletCode: row.code,
        outletName: row.name,
        isActive: row.is_active,
        totalRevenue: serializeAggregateMoney(row.revenue),
        totalSales: serializeAggregateCount(row.sale_count),
      })),
      total: count[0]?.total ?? 0,
    };
  }

  public async topSellingItems(
    outletId: string,
    range: DateRange,
  ): Promise<{ outlet: ReportOutlet; items: TopSellingItem[] } | null> {
    const [outlets, rows] = await this.database.$transaction(
      [
        this.database.$queryRaw<{ id: string; code: string; name: string; is_active: boolean }[]>`
          SELECT id, code, name, is_active FROM outlets WHERE id = ${outletId}::uuid`,
        this.database.$queryRaw<
          { menu_item_id: string; sku: string; name: string; quantity: string; revenue: string }[]
        >`
          SELECT si.menu_item_id, mi.sku, mi.name,
                 SUM(si.quantity)::text AS quantity,
                 SUM(si.line_total)::text AS revenue
          FROM sale_items si
          JOIN sales s ON s.id = si.sale_id AND s.outlet_id = si.outlet_id
          JOIN menu_items mi ON mi.id = si.menu_item_id
          WHERE si.outlet_id = ${outletId}::uuid ${salesInRange('s', range)}
          GROUP BY si.menu_item_id, mi.id
          ORDER BY SUM(si.quantity) DESC, si.menu_item_id ASC
          LIMIT ${TOP_SELLING_LIMIT}`,
      ],
      READ_SNAPSHOT,
    );
    const outlet = outlets[0];
    if (!outlet) return null;
    return {
      outlet: { id: outlet.id, code: outlet.code, name: outlet.name, isActive: outlet.is_active },
      items: rows.map((row, index) => ({
        rank: index + 1,
        menuItemId: row.menu_item_id,
        sku: row.sku,
        name: row.name,
        quantitySold: serializeAggregateCount(row.quantity),
        totalRevenue: serializeAggregateMoney(row.revenue),
      })),
    };
  }
}
