import '@/config/load-env.js';
import { createHash, randomUUID } from 'node:crypto';
import { Role } from '@/generated/prisma/enums.js';
import { ReportRepository } from '@/modules/reports/report.repository.js';
import type { DateRange } from '@/modules/reports/report.types.js';
import {
  connectDisposableDatabase,
  FIXTURE_CODE_PREFIX,
  FIXTURE_EMAIL_DOMAIN,
} from './support/disposable-database.js';

const db = await connectDisposableDatabase('REPORTS_VERIFICATION_DATABASE_URL');
const reports = new ReportRepository(db);
const results: { check: string; passed: boolean; detail: string }[] = [];

function check(name: string, passed: boolean, detail: unknown): void {
  results.push({ check: name, passed, detail: JSON.stringify(detail) });
}

const tag = randomUUID().slice(0, 6).toUpperCase();
const FROM = new Date('2099-03-01T00:00:00.000Z');
const TO = new Date('2099-04-01T00:00:00.000Z');
const WINDOW: DateRange = { from: FROM, to: TO };
const MID = new Date('2099-03-15T12:00:00.000Z');

const cents = (money: string): bigint => BigInt(money.replace('.', ''));

type Line = { item: string; quantity: number; price: string };

async function main(): Promise<void> {
  const before = await reports.summary(null);

  const cashier = await db.user.create({
    data: {
      email: `reports-${randomUUID()}${FIXTURE_EMAIL_DOMAIN}`,
      passwordHash: 'not-a-login-account',
      role: Role.OUTLET_STAFF,
    },
  });
  const createOutlet = (suffix: string): Promise<{ id: string }> =>
    db.outlet.create({
      data: { code: `${FIXTURE_CODE_PREFIX}${tag}${suffix}`, name: `Reports ${tag} ${suffix}` },
      select: { id: true },
    });
  const busy = await createOutlet('A');
  const closed = await createOutlet('B');
  const idle = await createOutlet('C');

  const items: string[] = [];
  for (let index = 1; index <= 7; index += 1) {
    const created = await db.menuItem.create({
      data: {
        sku: `${FIXTURE_CODE_PREFIX}${tag}-${index}`,
        name: `Item ${index}`,
        basePrice: '1.00',
      },
      select: { id: true },
    });
    items.push(created.id);
    for (const outlet of [busy, closed, idle]) {
      await db.outletMenuItem.create({
        data: { outletId: outlet.id, menuItemId: created.id, stockQuantity: 0 },
      });
    }
  }
  const item = (index: number): string => items[index - 1] ?? '';

  let receipt = 0;
  async function sale(outletId: string, createdAt: Date, lines: Line[]): Promise<void> {
    const totals = lines.map((line) => cents(line.price) * BigInt(line.quantity));
    const total = totals.reduce((sum, value) => sum + value, 0n);
    const format = (value: bigint): string =>
      `${value / 100n}.${(value % 100n).toString().padStart(2, '0')}`;
    receipt += 1;
    const created = await db.sale.create({
      data: {
        outletId,
        createdById: cashier.id,
        receiptNumber: receipt,
        requestId: randomUUID(),
        requestHash: createHash('sha256').update(randomUUID()).digest('hex'),
        totalAmount: format(total),
        createdAt,
      },
      select: { id: true },
    });
    await db.saleItem.createMany({
      data: lines.map((line, index) => ({
        saleId: created.id,
        outletId,
        menuItemId: line.item,
        itemName: `Item at sale time ${index}`,
        quantity: line.quantity,
        unitPrice: line.price,
        lineTotal: format(totals[index] ?? 0n),
      })),
    });
  }

  await sale(busy.id, FROM, [
    { item: item(1), quantity: 3, price: '10.00' },
    { item: item(2), quantity: 1, price: '250.00' },
  ]);
  await sale(busy.id, MID, [
    { item: item(1), quantity: 2, price: '12.50' },
    { item: item(3), quantity: 5, price: '1.00' },
  ]);
  await sale(busy.id, new Date(MID.getTime() + 1000), [
    { item: item(4), quantity: 5, price: '2.00' },
    { item: item(5), quantity: 4, price: '1.00' },
    { item: item(6), quantity: 4, price: '1.00' },
    { item: item(7), quantity: 1, price: '1.00' },
  ]);
  await sale(busy.id, TO, [{ item: item(4), quantity: 100, price: '1.00' }]);
  await sale(busy.id, new Date(FROM.getTime() - 1), [
    { item: item(5), quantity: 50, price: '1.00' },
  ]);
  await sale(closed.id, MID, [{ item: item(1), quantity: 1, price: '10.00' }]);
  await db.outlet.update({ where: { id: closed.id }, data: { isActive: false } });
  await db.menuItem.update({ where: { id: item(1) }, data: { name: 'Renamed burger' } });

  const windowed = await reports.summary(WINDOW);
  check(
    'summary revenue in window (boundary sales handled half-open)',
    windowed.totalRevenue === '339.00',
    windowed,
  );
  check('summary sales in window', windowed.totalSales === '4', windowed.totalSales);
  check(
    'summary units in window (no join multiplication)',
    windowed.totalUnitsSold === '26',
    windowed.totalUnitsSold,
  );
  const [counts] = await db.$queryRaw<{ total: number; active: number }[]>`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE is_active)::int AS active FROM outlets`;
  check(
    'outlet counts are current',
    windowed.totalOutlets === counts?.total && windowed.activeOutlets === counts.active,
    { windowed, counts },
  );

  const after = await reports.summary(null);
  check(
    'all-time revenue grew by every fixture sale (489.00)',
    cents(after.totalRevenue) - cents(before.totalRevenue) === 48_900n,
    { before: before.totalRevenue, after: after.totalRevenue },
  );
  check('all-time sales grew by 6', BigInt(after.totalSales) - BigInt(before.totalSales) === 6n, {
    before: before.totalSales,
    after: after.totalSales,
  });

  const empty = await reports.summary({
    from: new Date('2098-01-01T00:00:00Z'),
    to: new Date('2098-02-01T00:00:00Z'),
  });
  check(
    'empty range returns zeros',
    empty.totalRevenue === '0.00' && empty.totalSales === '0' && empty.totalUnitsSold === '0',
    empty,
  );

  const query = {
    page: 1,
    limit: 20,
    search: tag,
    sortBy: 'totalRevenue',
    sortOrder: 'desc',
  } as const;
  const byRevenue = await reports.revenueByOutlet(WINDOW, query);
  check(
    'revenue by outlet includes inactive and zero-sale outlets',
    JSON.stringify(
      byRevenue.items.map((row) => [
        row.outletCode.slice(-1),
        row.isActive,
        row.totalRevenue,
        row.totalSales,
      ]),
    ) ===
      JSON.stringify([
        ['A', true, '329.00', '3'],
        ['B', false, '10.00', '1'],
        ['C', true, '0.00', '0'],
      ]),
    byRevenue,
  );
  check('revenue by outlet total', byRevenue.total === 3, byRevenue.total);
  const bySales = await reports.revenueByOutlet(WINDOW, {
    ...query,
    sortBy: 'totalSales',
    sortOrder: 'asc',
  });
  check(
    'sorting by sale count ascending',
    bySales.items.map((row) => row.outletCode.slice(-1)).join() === 'C,B,A',
    bySales.items.map((row) => row.outletCode),
  );
  const paged = await reports.revenueByOutlet(WINDOW, { ...query, page: 2, limit: 2 });
  check(
    'pagination returns the remaining row',
    paged.items.length === 1 && paged.total === 3,
    paged,
  );

  const top = await reports.topSellingItems(busy.id, WINDOW);
  const tieOrder = [item(1), item(3), item(4)].sort();
  const restOrder = [item(5), item(6)].sort();
  check(
    'top five ranks by quantity with id tie-break',
    JSON.stringify(top?.items.map((row) => [row.menuItemId, row.quantitySold])) ===
      JSON.stringify([...tieOrder.map((id) => [id, '5']), ...restOrder.map((id) => [id, '4'])]),
    top?.items,
  );
  const burger = top?.items.find((row) => row.menuItemId === item(1));
  check(
    'same item at different prices sums line totals (30.00 + 25.00)',
    burger?.totalRevenue === '55.00',
    burger,
  );
  check(
    'current master name is used as the label',
    burger?.name === 'Renamed burger',
    burger?.name,
  );
  check(
    'ranks are 1..5',
    top?.items.map((row) => row.rank).join() === '1,2,3,4,5',
    top?.items.length,
  );
  const inactive = await reports.topSellingItems(closed.id, WINDOW);
  check(
    'inactive outlet is reportable',
    inactive?.outlet.isActive === false && inactive.items[0]?.quantitySold === '1',
    inactive,
  );
  const none = await reports.topSellingItems(idle.id, WINDOW);
  check('outlet without sales returns no items', none?.items.length === 0, none);
  check(
    'unknown outlet returns null',
    (await reports.topSellingItems(randomUUID(), null)) === null,
    null,
  );

  for (const result of results) {
    process.stdout.write(`${result.passed ? 'PASS' : 'FAIL'}  ${result.check}  ${result.detail}\n`);
  }
  const failed = results.filter((result) => !result.passed).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} checks passed\n`);
  process.exitCode = failed ? 1 : 0;
}

try {
  await main();
} finally {
  await db.$disconnect();
}
