import '@/config/load-env.js';
import { loadConfig } from '@/config/env.js';
import { createPrismaClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import {
  DEMO_ITEM_SKUS,
  DEMO_OUTLET_CODES,
  DEMO_STAFF_EMAILS,
} from '../prisma/demo-identifiers.js';
import { ReportRepository } from '@/modules/reports/report.repository.js';

const config = loadConfig();
const db = createPrismaClient({ ...config, DATABASE_POOL_MAX: 3 });
const reports = new ReportRepository(db);

const demoCodes = [...DEMO_OUTLET_CODES];
const demoSkus = [...DEMO_ITEM_SKUS];
const demoEmails = [...DEMO_STAFF_EMAILS];

type Scope = 'demo' | 'existing';
const outletScope = (scope: Scope, alias: string): Prisma.Sql =>
  scope === 'demo'
    ? Prisma.sql`${Prisma.raw(alias)}.code IN (${Prisma.join(demoCodes)})`
    : Prisma.sql`${Prisma.raw(alias)}.code NOT IN (${Prisma.join(demoCodes)})`;

async function integrity(scope: Scope): Promise<Record<string, number>> {
  const o = outletScope(scope, 'o');
  const [row] = await db.$queryRaw<Record<string, number>[]>`
    WITH scoped AS (SELECT id FROM outlets o WHERE ${o})
    SELECT
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND stock_quantity < 0) AS negative_stock,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND (override_price < 0 OR override_price = 'NaN')) AS bad_override_prices,
      (SELECT COUNT(*)::int FROM sales WHERE outlet_id IN (SELECT id FROM scoped) AND (total_amount < 0 OR total_amount = 'NaN')) AS bad_sale_totals,
      (SELECT COUNT(*)::int FROM sale_items WHERE outlet_id IN (SELECT id FROM scoped) AND (unit_price < 0 OR unit_price = 'NaN' OR line_total = 'NaN')) AS bad_line_prices,
      (SELECT COUNT(*)::int FROM sale_items WHERE outlet_id IN (SELECT id FROM scoped) AND quantity <= 0) AS invalid_quantities,
      (SELECT COUNT(*)::int FROM (SELECT outlet_id, receipt_number FROM sales WHERE outlet_id IN (SELECT id FROM scoped) GROUP BY 1, 2 HAVING COUNT(*) > 1) d) AS duplicate_receipts,
      (SELECT COUNT(*)::int FROM (SELECT outlet_id, request_id FROM sales WHERE outlet_id IN (SELECT id FROM scoped) GROUP BY 1, 2 HAVING COUNT(*) > 1) d) AS duplicate_request_ids,
      (SELECT COUNT(*)::int FROM (SELECT outlet_id, menu_item_id FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) GROUP BY 1, 2 HAVING COUNT(*) > 1) d) AS duplicate_assignments,
      (SELECT COUNT(*)::int FROM sales s WHERE s.outlet_id IN (SELECT id FROM scoped)
         AND s.total_amount <> (SELECT COALESCE(SUM(line_total), 0) FROM sale_items si WHERE si.sale_id = s.id)) AS sale_total_mismatch,
      (SELECT COUNT(*)::int FROM sale_items WHERE outlet_id IN (SELECT id FROM scoped) AND line_total <> unit_price * quantity) AS line_total_mismatch,
      (SELECT COUNT(*)::int FROM sales s WHERE s.outlet_id IN (SELECT id FROM scoped) AND NOT EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = s.id)) AS sales_without_items,
      (SELECT COUNT(*)::int FROM scoped WHERE id NOT IN (SELECT outlet_id FROM receipt_counters)) AS missing_receipt_counters,
      (SELECT COUNT(*)::int FROM receipt_counters rc WHERE rc.outlet_id IN (SELECT id FROM scoped)
         AND rc.last_number <> (SELECT COALESCE(MAX(receipt_number), 0) FROM sales s WHERE s.outlet_id = rc.outlet_id)) AS counter_mismatch,
      (SELECT COUNT(*)::int FROM receipt_counters rc WHERE rc.outlet_id IN (SELECT id FROM scoped)
         AND rc.last_number <> (SELECT COUNT(*) FROM sales s WHERE s.outlet_id = rc.outlet_id)) AS receipt_gaps,
      (SELECT COUNT(*)::int FROM sale_items si JOIN sales s ON s.id = si.sale_id
         WHERE si.outlet_id IN (SELECT id FROM scoped) AND s.outlet_id <> si.outlet_id) AS cross_outlet_sale_items,
      (SELECT COUNT(*)::int FROM sale_items si WHERE si.outlet_id IN (SELECT id FROM scoped)
         AND NOT EXISTS (SELECT 1 FROM outlet_menu_items omi WHERE omi.outlet_id = si.outlet_id AND omi.menu_item_id = si.menu_item_id)) AS orphan_sale_items,
      (SELECT COUNT(*)::int FROM sales s WHERE s.outlet_id IN (SELECT id FROM scoped)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = s.created_by_id)) AS orphan_sale_creators,
      (SELECT COUNT(*)::int FROM outlet_memberships m WHERE m.outlet_id IN (SELECT id FROM scoped)
         AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.user_id AND u.role = 'OUTLET_STAFF')) AS invalid_memberships`;
  return row ?? {};
}

async function counts(scope: Scope): Promise<Record<string, number>> {
  const o = outletScope(scope, 'o');
  const demoItems =
    scope === 'demo'
      ? Prisma.sql`sku IN (${Prisma.join(demoSkus)})`
      : Prisma.sql`sku NOT IN (${Prisma.join(demoSkus)})`;
  const demoUsers =
    scope === 'demo'
      ? Prisma.sql`email IN (${Prisma.join(demoEmails)})`
      : Prisma.sql`email NOT IN (${Prisma.join(demoEmails)})`;
  const [row] = await db.$queryRaw<Record<string, number>[]>`
    WITH scoped AS (SELECT id, is_active FROM outlets o WHERE ${o})
    SELECT
      (SELECT COUNT(*)::int FROM scoped) AS outlets,
      (SELECT COUNT(*)::int FROM scoped WHERE is_active) AS active_outlets,
      (SELECT COUNT(*)::int FROM users WHERE role = 'OUTLET_STAFF' AND ${demoUsers}) AS staff,
      (SELECT COUNT(*)::int FROM users WHERE role = 'HQ_ADMIN') AS hq_admins_total,
      (SELECT COUNT(*)::int FROM outlet_memberships WHERE outlet_id IN (SELECT id FROM scoped)) AS memberships,
      (SELECT COUNT(*)::int FROM menu_items WHERE ${demoItems}) AS menu_items,
      (SELECT COUNT(*)::int FROM menu_items WHERE ${demoItems} AND NOT is_active) AS inactive_menu_items,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped)) AS assignments,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND NOT is_active) AS inactive_assignments,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND override_price IS NOT NULL) AS price_overrides,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND override_price = 0) AS zero_price_overrides,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND stock_quantity = 0) AS out_of_stock,
      (SELECT COUNT(*)::int FROM outlet_menu_items WHERE outlet_id IN (SELECT id FROM scoped) AND stock_quantity BETWEEN 1 AND 10) AS low_stock,
      (SELECT COUNT(*)::int FROM receipt_counters WHERE outlet_id IN (SELECT id FROM scoped)) AS receipt_counters,
      (SELECT COUNT(*)::int FROM sales WHERE outlet_id IN (SELECT id FROM scoped)) AS sales,
      (SELECT COUNT(*)::int FROM sale_items WHERE outlet_id IN (SELECT id FROM scoped)) AS sale_items`;
  return row ?? {};
}

try {
  const [target] = await db.$queryRaw<{ name: string }[]>`SELECT current_database() AS name`;
  const result: Record<string, unknown> = { database: target?.name };
  for (const scope of ['demo', 'existing'] as const) {
    result[scope] = { counts: await counts(scope), integrity: await integrity(scope) };
  }
  const demoOutlets = await db.outlet.findMany({
    where: { code: { in: demoCodes } },
    orderBy: { code: 'asc' },
    select: { id: true, code: true, isActive: true },
  });
  const revenue = await reports.revenueByOutlet(null, {
    page: 1,
    limit: 100,
    search: '',
    sortBy: 'totalRevenue',
    sortOrder: 'desc',
  });
  const demoRevenue = revenue.items.filter((row) =>
    (demoCodes as readonly string[]).includes(row.outletCode),
  );
  const top: Record<string, string[]> = {};
  for (const outlet of demoOutlets) {
    const report = await reports.topSellingItems(outlet.id, null);
    top[outlet.code] = (report?.items ?? []).map(
      (item) => `${item.rank}. ${item.name} — ${item.quantitySold} units, ৳${item.totalRevenue}`,
    );
  }
  const [demoRevenueRow] = await db.$queryRaw<
    { revenue: string; first: Date | null; last: Date | null }[]
  >`
    SELECT COALESCE(SUM(s.total_amount), 0)::text AS revenue, MIN(s.created_at) AS first, MAX(s.created_at) AS last
    FROM sales s JOIN outlets o ON o.id = s.outlet_id WHERE o.code IN (${Prisma.join(demoCodes)})`;
  const staff = await db.user.findMany({
    where: { email: { in: demoEmails } },
    orderBy: { email: 'asc' },
    select: {
      email: true,
      role: true,
      isActive: true,
      memberships: { select: { outlet: { select: { code: true } } } },
    },
  });
  result.business = {
    demoRevenue: demoRevenueRow,
    revenueByOutlet: demoRevenue.map(
      (row) =>
        `${row.outletCode} (${row.isActive ? 'active' : 'inactive'}): ৳${row.totalRevenue} over ${row.totalSales} sales`,
    ),
    topFive: top,
    staff: staff.map((member) => ({
      email: member.email,
      role: member.role,
      active: member.isActive,
      outlets: member.memberships.map((row) => row.outlet.code).sort(),
    })),
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await db.$disconnect();
}
