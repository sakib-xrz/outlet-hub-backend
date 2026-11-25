import '@/config/load-env.js';
import { randomUUID } from 'node:crypto';
import { AppError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { createPrismaClient } from '@/database/client.js';
import { incrementReceiptCounter, lockReceiptCounter } from '@/database/locks.js';
import { Role } from '@/generated/prisma/enums.js';
import { InventoryRepository } from '@/modules/inventory/inventory.repository.js';
import { InventoryService } from '@/modules/inventory/inventory.service.js';
import { MenuItemRepository } from '@/modules/menu-items/menu-item.repository.js';
import { OutletMenuItemRepository } from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';
import { OutletRepository } from '@/modules/outlets/outlet.repository.js';
import { SaleRepository } from '@/modules/sales/sale.repository.js';
import { SaleService } from '@/modules/sales/sale.service.js';
import { StaffRepository } from '@/modules/staff/staff.repository.js';

const url = process.env.SALES_VERIFICATION_DATABASE_URL;
if (!url || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'yes') {
  throw new Error(
    'Refusing to run: set SALES_VERIFICATION_DATABASE_URL to a disposable, migrated database and CONFIRM_DISPOSABLE_DATABASE=yes.',
  );
}
if (url === process.env.DATABASE_URL) {
  throw new Error('Refusing to run against the configured application DATABASE_URL.');
}

const db = createPrismaClient({
  DATABASE_URL: url,
  DATABASE_POOL_MAX: 25,
  DATABASE_CONNECTION_TIMEOUT_MS: 15_000,
  DATABASE_IDLE_TIMEOUT_MS: 10_000,
});
const sales = new SaleService(new SaleRepository(db));
const inventory = new InventoryService(new InventoryRepository(db));
const outlets = new OutletRepository(db);
const menuItems = new MenuItemRepository(db);
const outletMenu = new OutletMenuItemRepository(db);
const staffRepository = new StaffRepository(db);

const results: { scenario: string; check: string; passed: boolean; detail: string }[] = [];
function first<T>(values: readonly T[]): T {
  const value = values[0];
  if (value === undefined) throw new Error('Fixture is missing an expected record');
  return value;
}

const tag = (): string => randomUUID().slice(0, 6).toUpperCase();

function check(scenario: string, name: string, passed: boolean, detail: unknown): void {
  results.push({ scenario, check: name, passed, detail: JSON.stringify(detail) });
}

const codeOf = (outcome: PromiseSettledResult<unknown>): string =>
  outcome.status === 'fulfilled'
    ? 'OK'
    : outcome.reason instanceof AppError
      ? outcome.reason.code
      : String(outcome.reason);

async function createUser(role: Role): Promise<AuthenticatedUser> {
  const email = `verify-${randomUUID()}@example.invalid`;
  const user = await db.user.create({
    data: { email, passwordHash: 'not-a-login-account', role, isActive: true },
    select: { id: true, email: true, role: true },
  });
  return user;
}

async function createFixture(
  items: { price: string; stock: number }[],
  staffCount = 1,
): Promise<{
  outletId: string;
  itemIds: string[];
  staff: AuthenticatedUser[];
  admin: AuthenticatedUser;
}> {
  const admin = await createUser(Role.HQ_ADMIN);
  const outlet = await outlets.createWithReceiptCounter({
    code: `VERIFY-${tag()}`,
    name: 'Concurrency verification outlet',
    address: null,
  });
  const itemIds: string[] = [];
  for (const item of items) {
    const created = await menuItems.create({
      sku: `VERIFY-${tag()}`,
      name: `Verification item ${tag()}`,
      description: null,
      basePrice: item.price,
    });
    await db.outletMenuItem.create({
      data: { outletId: outlet.id, menuItemId: created.id, stockQuantity: item.stock },
    });
    itemIds.push(created.id);
  }
  const staff: AuthenticatedUser[] = [];
  for (let index = 0; index < staffCount; index += 1) {
    const member = await createUser(Role.OUTLET_STAFF);
    await db.outletMembership.create({ data: { userId: member.id, outletId: outlet.id } });
    staff.push(member);
  }
  return { outletId: outlet.id, itemIds, staff, admin };
}

const stockOf = async (outletId: string, menuItemId: string): Promise<number> =>
  (
    await db.outletMenuItem.findUniqueOrThrow({
      where: { outletId_menuItemId: { outletId, menuItemId } },
    })
  ).stockQuantity;
const counterOf = async (outletId: string): Promise<number> =>
  (await db.receiptCounter.findUniqueOrThrow({ where: { outletId } })).lastNumber;
const salesCount = (outletId: string): Promise<number> => db.sale.count({ where: { outletId } });

const sell = (
  user: AuthenticatedUser,
  outletId: string,
  lines: { menuItemId: string; quantity: number; price: string }[],
  requestId: string = randomUUID(),
): ReturnType<SaleService['create']> =>
  sales.create(user, outletId, {
    requestId,
    items: lines.map((line) => ({
      menuItemId: line.menuItemId,
      quantity: line.quantity,
      expectedUnitPrice: line.price,
    })),
  });

async function scenarioA(): Promise<void> {
  const { outletId, itemIds, staff } = await createFixture([{ price: '50.00', stock: 10 }], 2);
  const item = first(itemIds);
  const outcomes = await Promise.allSettled(
    staff.map((user) => sell(user, outletId, [{ menuItemId: item, quantity: 7, price: '50.00' }])),
  );
  const codes = outcomes.map(codeOf).sort();
  check(
    'A',
    'exactly one sale succeeds, one is INSUFFICIENT_STOCK',
    codes.join() === 'INSUFFICIENT_STOCK,OK',
    codes,
  );
  check(
    'A',
    'final stock is 3',
    (await stockOf(outletId, item)) === 3,
    await stockOf(outletId, item),
  );
  check(
    'A',
    'receipt counter increased once',
    (await counterOf(outletId)) === 1,
    await counterOf(outletId),
  );
  check('A', 'one sale exists', (await salesCount(outletId)) === 1, await salesCount(outletId));
}

async function scenarioB(): Promise<void> {
  const { outletId, itemIds, staff } = await createFixture([{ price: '10.00', stock: 20 }]);
  const item = first(itemIds);
  const cashier = first(staff);
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      sell(cashier, outletId, [{ menuItemId: item, quantity: 1, price: '10.00' }]),
    ),
  );
  const ok = outcomes.filter((outcome) => outcome.status === 'fulfilled').length;
  const numbers = (await db.sale.findMany({ where: { outletId }, select: { receiptNumber: true } }))
    .map((row) => row.receiptNumber)
    .sort((a, b) => a - b);
  check('B', 'all ten sales succeed', ok === 10, outcomes.map(codeOf));
  check(
    'B',
    'final stock is 10',
    (await stockOf(outletId, item)) === 10,
    await stockOf(outletId, item),
  );
  check(
    'B',
    'receipt numbers are 1..10, unique and consecutive',
    numbers.join() === '1,2,3,4,5,6,7,8,9,10',
    numbers,
  );
}

async function scenarioC(): Promise<void> {
  const { outletId, itemIds, staff } = await createFixture([{ price: '25.00', stock: 5 }]);
  const item = first(itemIds);
  const cashier = first(staff);
  const requestId = randomUUID();
  const outcomes = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      sell(cashier, outletId, [{ menuItemId: item, quantity: 2, price: '25.00' }], requestId),
    ),
  );
  const saleIds = new Set(
    outcomes.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value.sale.id] : [])),
  );
  const created = outcomes.filter((o) => o.status === 'fulfilled' && !o.value.replayed).length;
  check('C', 'all responses reference one sale', saleIds.size === 1, [...saleIds]);
  check('C', 'exactly one creation, the rest replays', created === 1, outcomes.map(codeOf));
  check(
    'C',
    'stock deducted once',
    (await stockOf(outletId, item)) === 3,
    await stockOf(outletId, item),
  );
  check(
    'C',
    'counter increased once',
    (await counterOf(outletId)) === 1,
    await counterOf(outletId),
  );
  check('C', 'one sale exists', (await salesCount(outletId)) === 1, await salesCount(outletId));
}

async function scenarioD(): Promise<void> {
  const { outletId, itemIds, staff } = await createFixture([
    { price: '10.00', stock: 10 },
    { price: '20.00', stock: 1 },
  ]);
  const firstItem = first(itemIds);
  const secondItem = itemIds[1] ?? '';
  const outcome = await Promise.allSettled([
    sell(first(staff), outletId, [
      { menuItemId: firstItem, quantity: 5, price: '10.00' },
      { menuItemId: secondItem, quantity: 2, price: '20.00' },
    ]),
  ]);
  check(
    'D',
    'the whole sale fails with INSUFFICIENT_STOCK',
    codeOf(first(outcome)) === 'INSUFFICIENT_STOCK',
    outcome.map(codeOf),
  );
  check(
    'D',
    'no stock changed',
    (await stockOf(outletId, firstItem)) === 10 && (await stockOf(outletId, secondItem)) === 1,
    [await stockOf(outletId, firstItem), await stockOf(outletId, secondItem)],
  );
  check(
    'D',
    'no receipt number consumed',
    (await counterOf(outletId)) === 0,
    await counterOf(outletId),
  );
  check(
    'D',
    'no sale or sale item rows',
    (await salesCount(outletId)) === 0 && (await db.saleItem.count({ where: { outletId } })) === 0,
    null,
  );
}

async function scenarioE(): Promise<void> {
  const one = await createFixture([{ price: '5.00', stock: 10 }]);
  const two = await createFixture([{ price: '5.00', stock: 10 }]);
  await Promise.all(
    [one, two].flatMap((fixture) =>
      Array.from({ length: 5 }, () =>
        sell(first(fixture.staff), fixture.outletId, [
          { menuItemId: first(fixture.itemIds), quantity: 1, price: '5.00' },
        ]),
      ),
    ),
  );
  check(
    'E',
    'outlet one counter is 5',
    (await counterOf(one.outletId)) === 5,
    await counterOf(one.outletId),
  );
  check(
    'E',
    'outlet two counter is 5',
    (await counterOf(two.outletId)) === 5,
    await counterOf(two.outletId),
  );
  check(
    'E',
    'stock changed only per outlet',
    (await stockOf(one.outletId, first(one.itemIds))) === 5 &&
      (await stockOf(two.outletId, first(two.itemIds))) === 5,
    null,
  );
}

async function scenarioF(): Promise<void> {
  const { outletId, itemIds, staff, admin } = await createFixture([{ price: '10.00', stock: 10 }]);
  const item = first(itemIds);
  const outcomes = await Promise.allSettled([
    sell(first(staff), outletId, [{ menuItemId: item, quantity: 4, price: '10.00' }]),
    inventory.adjust(admin, outletId, item, { operation: 'INCREASE', quantity: 5 }),
  ]);
  check(
    'F',
    'both operations commit',
    outcomes.every((o) => o.status === 'fulfilled'),
    outcomes.map(codeOf),
  );
  check(
    'F',
    'no lost update: 10 − 4 + 5 = 11',
    (await stockOf(outletId, item)) === 11,
    await stockOf(outletId, item),
  );
}

async function scenarioG(): Promise<void> {
  const { outletId, itemIds, staff, admin } = await createFixture([{ price: '100.00', stock: 10 }]);
  const item = first(itemIds);
  const [saleOutcome] = await Promise.allSettled([
    sell(first(staff), outletId, [{ menuItemId: item, quantity: 1, price: '100.00' }]),
    menuItems.update(item, { basePrice: '120.00' }),
    outletMenu.setOverridePrice(admin.id, outletId, item, null),
  ]);
  const code = codeOf(saleOutcome);
  const stock = await stockOf(outletId, item);
  const recorded = await db.saleItem.findFirst({
    where: { outletId },
    select: { unitPrice: true },
  });
  check(
    'G',
    'sale either commits at the old price or is PRICE_CHANGED',
    (code === 'OK' && recorded?.unitPrice.toFixed(2) === '100.00' && stock === 9) ||
      (code === 'PRICE_CHANGED' && stock === 10 && !recorded),
    { code, stock, price: recorded?.unitPrice.toFixed(2) },
  );
}

async function scenarioH(): Promise<void> {
  const { outletId, itemIds, staff } = await createFixture([{ price: '10.00', stock: 10 }]);
  const cashier = first(staff);
  const [saleOutcome] = await Promise.allSettled([
    sell(cashier, outletId, [{ menuItemId: first(itemIds), quantity: 1, price: '10.00' }]),
    staffRepository.replaceOutlets(cashier.id, []),
  ]);
  const code = codeOf(saleOutcome);
  const membership = await db.outletMembership.count({ where: { userId: cashier.id } });
  check(
    'H',
    'sale commits before revocation or is AUTHORIZATION_ERROR after it',
    (code === 'OK' || code === 'AUTHORIZATION_ERROR') && membership === 0,
    { code, membership, sales: await salesCount(outletId) },
  );
}

async function scenarioI(): Promise<void> {
  const { outletId, itemIds } = await createFixture([{ price: '10.00', stock: 10 }]);
  const item = first(itemIds);
  const failure = await Promise.allSettled([
    db.$transaction(async (transaction) => {
      await lockReceiptCounter(transaction, outletId);
      await transaction.outletMenuItem.updateMany({
        where: { outletId, menuItemId: item, stockQuantity: { gte: 3 } },
        data: { stockQuantity: { decrement: 3 } },
      });
      await incrementReceiptCounter(transaction, outletId);
      throw new Error('Injected failure after stock deduction and counter increment');
    }),
  ]);
  check('I', 'injected failure aborts the transaction', first(failure).status === 'rejected', null);
  check(
    'I',
    'stock unchanged',
    (await stockOf(outletId, item)) === 10,
    await stockOf(outletId, item),
  );
  check('I', 'counter unchanged', (await counterOf(outletId)) === 0, await counterOf(outletId));
}

async function main(): Promise<void> {
  for (const scenario of [
    scenarioA,
    scenarioB,
    scenarioC,
    scenarioD,
    scenarioE,
    scenarioF,
    scenarioG,
    scenarioH,
    scenarioI,
  ]) {
    await scenario();
  }
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'}  [${result.scenario}] ${result.check}  ${result.detail}\n`,
    );
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
