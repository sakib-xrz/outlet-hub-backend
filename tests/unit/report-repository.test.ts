import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import {
  ReportRepository,
  serializeAggregateCount,
  serializeAggregateMoney,
} from '@/modules/reports/report.repository.js';

type Captured = { sql: string; values: unknown[] };

function fake(results: unknown[][]): {
  database: DatabaseClient;
  queries: Captured[];
  transaction: Mock;
} {
  const queries: Captured[] = [];
  let next = 0;
  const queryRaw = (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> => {
    const sql = Prisma.sql(strings, ...values);
    queries.push({ sql: sql.text.replace(/\s+/g, ' ').trim(), values: sql.values });
    return Promise.resolve(results[next++] ?? []);
  };
  const transaction = vi.fn((operations: Promise<unknown>[]) => Promise.all(operations));
  return {
    database: { $queryRaw: queryRaw, $transaction: transaction } as unknown as DatabaseClient,
    queries,
    transaction,
  };
}

const RANGE = { from: new Date('2026-11-01T00:00:00Z'), to: new Date('2026-12-01T00:00:00Z') };
const REPEATABLE_READ = { isolationLevel: 'RepeatableRead' };

describe('aggregate serialization', () => {
  it.each([
    ['0', '0.00'],
    ['12', '12.00'],
    ['12.5', '12.50'],
    ['148500.00', '148500.00'],
    ['123456789012345678901234.99', '123456789012345678901234.99'],
  ])('normalizes money %s', (input, output) => {
    expect(serializeAggregateMoney(input)).toBe(output);
  });

  it.each(['NaN', '-1.00', '1.005', '1e5', '', 'Infinity'])('rejects money %s', (input) => {
    expect(() => serializeAggregateMoney(input)).toThrow(/Corrupted/);
  });

  it('keeps counts exact beyond 2^53', () => {
    expect(serializeAggregateCount('9007199254740993')).toBe('9007199254740993');
    expect(serializeAggregateCount('0')).toBe('0');
    expect(() => serializeAggregateCount('NaN')).toThrow(/Corrupted/);
    expect(() => serializeAggregateCount('1.5')).toThrow(/Corrupted/);
  });
});

describe('ReportRepository.summary', () => {
  it('aggregates in one repeatable-read snapshot without join multiplication', async () => {
    const { database, queries, transaction } = fake([
      [{ revenue: '148500.5', sale_count: '594' }],
      [{ units: '1248' }],
      [{ total: 5, active: 4 }],
    ]);
    const summary = await new ReportRepository(database).summary(RANGE);
    expect(summary).toEqual({
      totalRevenue: '148500.50',
      totalSales: '594',
      totalUnitsSold: '1248',
      totalOutlets: 5,
      activeOutlets: 4,
    });
    expect(transaction).toHaveBeenCalledWith(expect.any(Array), REPEATABLE_READ);
    const [sales, units, outlets] = queries;
    expect(sales?.sql).toContain('SUM(s.total_amount)');
    expect(sales?.sql).not.toContain('sale_items');
    expect(sales?.sql).toContain('s.created_at >= $1 AND s.created_at < $2');
    expect(sales?.values).toEqual([RANGE.from, RANGE.to]);
    expect(units?.sql).toContain(
      'JOIN sales s ON s.id = si.sale_id AND s.outlet_id = si.outlet_id',
    );
    expect(units?.sql).not.toContain('total_amount');
    expect(outlets?.sql).not.toContain('created_at');
    expect(queries.every((query) => !query.sql.includes('SELECT *'))).toBe(true);
    expect(queries.every((query) => !/FOR (UPDATE|SHARE)/.test(query.sql))).toBe(true);
  });

  it('returns zeros for an empty dataset and no range filter for all-time', async () => {
    const { database, queries } = fake([
      [{ revenue: '0', sale_count: '0' }],
      [{ units: '0' }],
      [{ total: 0, active: 0 }],
    ]);
    const summary = await new ReportRepository(database).summary(null);
    expect(summary).toEqual({
      totalRevenue: '0.00',
      totalSales: '0',
      totalUnitsSold: '0',
      totalOutlets: 0,
      activeOutlets: 0,
    });
    expect(queries.some((query) => query.sql.includes('created_at'))).toBe(false);
  });

  it('throws on a corrupted NaN aggregate', async () => {
    const { database } = fake([
      [{ revenue: 'NaN', sale_count: '1' }],
      [{ units: '1' }],
      [{ total: 1, active: 1 }],
    ]);
    await expect(new ReportRepository(database).summary(null)).rejects.toThrow(/Corrupted/);
  });
});

describe('ReportRepository.revenueByOutlet', () => {
  const query = { page: 3, limit: 10, sortBy: 'totalRevenue' as const, sortOrder: 'desc' as const };

  it('left-joins a date-filtered aggregate and paginates in SQL', async () => {
    const { database, queries } = fake([
      [
        { id: 'o1', code: 'A', name: 'Alpha', is_active: false, revenue: '10.5', sale_count: '2' },
        { id: 'o2', code: 'B', name: 'Beta', is_active: true, revenue: '0', sale_count: '0' },
      ],
      [{ total: 22 }],
    ]);
    const result = await new ReportRepository(database).revenueByOutlet(RANGE, query);
    expect(result).toEqual({
      items: [
        {
          outletId: 'o1',
          outletCode: 'A',
          outletName: 'Alpha',
          isActive: false,
          totalRevenue: '10.50',
          totalSales: '2',
        },
        {
          outletId: 'o2',
          outletCode: 'B',
          outletName: 'Beta',
          isActive: true,
          totalRevenue: '0.00',
          totalSales: '0',
        },
      ],
      total: 22,
    });
    const sql = queries[0]?.sql ?? '';
    expect(sql).toMatch(
      /FROM outlets o LEFT JOIN \( SELECT .* FROM sales s WHERE TRUE AND s\.created_at >= \$1 AND s\.created_at < \$2 GROUP BY s\.outlet_id \) agg/,
    );
    expect(sql).toContain('ORDER BY COALESCE(agg.revenue, 0) DESC, o.id ASC');
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect(queries[0]?.values).toEqual([RANGE.from, RANGE.to, 10, 20]);
    expect(sql).not.toMatch(/WHERE o\./);
  });

  it('uses allowlisted sort fragments and escapes search wildcards', async () => {
    const { database, queries } = fake([[], [{ total: 0 }]]);
    await new ReportRepository(database).revenueByOutlet(null, {
      ...query,
      page: 1,
      sortBy: 'code',
      sortOrder: 'asc',
      search: '50%_off\\',
    });
    const [rows, count] = queries;
    expect(rows?.sql).toContain('ORDER BY o.code ASC, o.id ASC');
    expect(rows?.sql).toContain("o.code ILIKE $1 ESCAPE '\\'");
    expect(rows?.values[0]).toBe('%50\\%\\_off\\\\%');
    expect(count?.sql).toContain('FROM outlets o WHERE');
    expect(count?.values).toEqual(['%50\\%\\_off\\\\%', '%50\\%\\_off\\\\%']);
  });
});

describe('ReportRepository.topSellingItems', () => {
  it('returns null when the outlet does not exist', async () => {
    const { database } = fake([[], []]);
    expect(await new ReportRepository(database).topSellingItems('o1', null)).toBeNull();
  });

  it('ranks by quantity with id tie-break, joined on the composite sale key', async () => {
    const { database, queries } = fake([
      [{ id: 'o1', code: 'A', name: 'Alpha', is_active: false }],
      [
        { menu_item_id: 'm1', sku: 'BUR', name: 'Burger', quantity: '7', revenue: '1750' },
        { menu_item_id: 'm2', sku: 'TEA', name: 'Tea', quantity: '7', revenue: '140.5' },
      ],
    ]);
    const result = await new ReportRepository(database).topSellingItems('o1', RANGE);
    expect(result).toEqual({
      outlet: { id: 'o1', code: 'A', name: 'Alpha', isActive: false },
      items: [
        {
          rank: 1,
          menuItemId: 'm1',
          sku: 'BUR',
          name: 'Burger',
          quantitySold: '7',
          totalRevenue: '1750.00',
        },
        {
          rank: 2,
          menuItemId: 'm2',
          sku: 'TEA',
          name: 'Tea',
          quantitySold: '7',
          totalRevenue: '140.50',
        },
      ],
    });
    const sql = queries[1]?.sql ?? '';
    expect(sql).toContain('JOIN sales s ON s.id = si.sale_id AND s.outlet_id = si.outlet_id');
    expect(sql).toContain('SUM(si.line_total)');
    expect(sql).toContain('GROUP BY si.menu_item_id');
    expect(sql).toContain('ORDER BY SUM(si.quantity) DESC, si.menu_item_id ASC');
    expect(sql).toContain('LIMIT $4');
    expect(queries[1]?.values).toEqual(['o1', RANGE.from, RANGE.to, 5]);
  });
});
