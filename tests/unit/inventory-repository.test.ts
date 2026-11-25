import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import type { AssignmentRow } from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';
import type { AdjustmentOutcome } from '@/modules/inventory/inventory.types.js';
import {
  classifyStock,
  InventoryRepository,
  nextStockQuantity,
} from '@/modules/inventory/inventory.repository.js';

const MAX = 2_147_483_647;

describe('classifyStock (threshold 10)', () => {
  it.each([
    [0, 'OUT_OF_STOCK'],
    [1, 'LOW'],
    [10, 'LOW'],
    [11, 'IN_STOCK'],
    [MAX, 'IN_STOCK'],
  ])('%i → %s', (quantity, status) => {
    expect(classifyStock(quantity)).toBe(status);
  });
});

describe('nextStockQuantity', () => {
  it.each([
    [50, { operation: 'INCREASE', quantity: 20 }, { kind: 'ok', quantity: 70 }],
    [50, { operation: 'DECREASE', quantity: 15 }, { kind: 'ok', quantity: 35 }],
    [7, { operation: 'DECREASE', quantity: 7 }, { kind: 'ok', quantity: 0 }],
    [3, { operation: 'DECREASE', quantity: 7 }, { kind: 'insufficient' }],
    [MAX - 1, { operation: 'INCREASE', quantity: 1 }, { kind: 'ok', quantity: MAX }],
    [MAX, { operation: 'INCREASE', quantity: 1 }, { kind: 'overflow' }],
    [
      50,
      { operation: 'SET', quantity: 40, expectedStockQuantity: 50 },
      { kind: 'ok', quantity: 40 },
    ],
    [48, { operation: 'SET', quantity: 40, expectedStockQuantity: 50 }, { kind: 'stale' }],
  ] as const)('from %i applies %j', (current, adjustment, expected) => {
    expect(nextStockQuantity(current, adjustment)).toEqual(expected);
  });
});

type Fake = {
  database: DatabaseClient;
  calls: string[];
  update: Mock;
  findUniqueOrThrow: Mock;
  findMany: Mock;
  count: Mock;
};

function row(stockQuantity: number): AssignmentRow {
  return {
    outletId: 'o',
    menuItemId: 'm',
    overridePrice: new Prisma.Decimal('280'),
    stockQuantity,
    isActive: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    outlet: { isActive: true },
    menuItem: {
      sku: 'B-1',
      name: 'Burger',
      description: null,
      basePrice: new Prisma.Decimal('250'),
      isActive: false,
    },
  };
}

function fake(state: {
  admin?: { role: string; isActive: boolean } | null;
  outlet?: { isActive: boolean } | null;
  stock?: number | null;
}): Fake {
  const calls: string[] = [];
  const admin = state.admin === undefined ? { role: 'HQ_ADMIN', isActive: true } : state.admin;
  const outlet = state.outlet === undefined ? { isActive: true } : state.outlet;
  const stock = state.stock === undefined ? 50 : state.stock;
  const queryRaw = vi.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM users')) {
      calls.push(`lock-user${sql.includes('FOR SHARE') ? '-share' : ''}`);
      return Promise.resolve(
        admin ? [{ id: 'a', role: admin.role, is_active: admin.isActive, password_hash: 'h' }] : [],
      );
    }
    if (sql.includes('FROM outlet_menu_items')) {
      calls.push(`lock-assignment${sql.includes('FOR UPDATE') ? '-update' : ''}`);
      return Promise.resolve(stock === null ? [] : [{ is_active: false, stock_quantity: stock }]);
    }
    calls.push(`lock-outlet${sql.includes('FOR SHARE') ? '-share' : ''}`);
    return Promise.resolve(outlet ? [{ is_active: outlet.isActive }] : []);
  });
  const update = vi.fn((args: { data: { stockQuantity: number } }) => {
    calls.push('update');
    return Promise.resolve(row(args.data.stockQuantity));
  });
  const findUniqueOrThrow = vi.fn(() => {
    calls.push('read');
    return Promise.resolve(row(stock ?? 0));
  });
  const findMany = vi.fn(() => Promise.resolve([]));
  const count = vi.fn(() => Promise.resolve(0));
  const transaction = { $queryRaw: queryRaw, outletMenuItem: { update, findUniqueOrThrow } };
  const database = {
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: typeof transaction) => Promise<unknown>)(transaction)
        : Promise.all(arg as Promise<unknown>[]),
    ),
    outletMenuItem: { findMany, count },
  } as unknown as DatabaseClient;
  return { database, calls, update, findUniqueOrThrow, findMany, count };
}

const adjust = (
  db: Fake,
  adjustment: Parameters<InventoryRepository['adjust']>[3],
): Promise<AdjustmentOutcome> =>
  new InventoryRepository(db.database).adjust('admin', 'o', 'm', adjustment);

describe('InventoryRepository.adjust (mocked transaction orchestration)', () => {
  it('locks user → outlet → assignment and updates only stockQuantity from the locked balance', async () => {
    const db = fake({ stock: 50 });
    const outcome = await adjust(db, { operation: 'INCREASE', quantity: 20 });

    expect(db.calls).toEqual([
      'lock-user-share',
      'lock-outlet-share',
      'lock-assignment-update',
      'update',
    ]);
    expect(db.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { outletId_menuItemId: { outletId: 'o', menuItemId: 'm' } },
        data: { stockQuantity: 70 },
      }),
    );
    expect(outcome).toMatchObject({
      kind: 'ok',
      result: {
        operation: 'INCREASE',
        previousStockQuantity: 50,
        newStockQuantity: 70,
        changed: true,
        inventoryItem: {
          stockQuantity: 70,
          stockStatus: 'IN_STOCK',
          isActive: false,
          menuItemIsActive: false,
        },
      },
    });
  });

  it('allows correcting inactive assignments and inactive master items in an active outlet', async () => {
    const db = fake({ stock: 5 });
    await expect(adjust(db, { operation: 'DECREASE', quantity: 5 })).resolves.toMatchObject({
      kind: 'ok',
      result: { newStockQuantity: 0, inventoryItem: { stockStatus: 'OUT_OF_STOCK' } },
    });
  });

  it('does not write for a SET to the current value', async () => {
    const db = fake({ stock: 40 });
    const outcome = await adjust(db, { operation: 'SET', quantity: 40, expectedStockQuantity: 40 });
    expect(db.update).not.toHaveBeenCalled();
    expect(db.calls.at(-1)).toBe('read');
    expect(outcome).toMatchObject({ kind: 'ok', result: { changed: false, newStockQuantity: 40 } });
  });

  it.each([
    [
      { stock: 3 },
      { operation: 'DECREASE', quantity: 7 },
      { kind: 'insufficient', currentStockQuantity: 3 },
    ],
    [
      { stock: MAX },
      { operation: 'INCREASE', quantity: 1 },
      { kind: 'overflow', currentStockQuantity: MAX },
    ],
    [
      { stock: 48 },
      { operation: 'SET', quantity: 40, expectedStockQuantity: 50 },
      { kind: 'stale', currentStockQuantity: 48 },
    ],
    [{ stock: null }, { operation: 'INCREASE', quantity: 1 }, { kind: 'assignment-not-found' }],
    [
      { outlet: { isActive: false } },
      { operation: 'INCREASE', quantity: 1 },
      { kind: 'outlet-inactive' },
    ],
    [{ outlet: null }, { operation: 'INCREASE', quantity: 1 }, { kind: 'outlet-not-found' }],
    [
      { admin: { role: 'OUTLET_STAFF', isActive: true } },
      { operation: 'INCREASE', quantity: 1 },
      { kind: 'forbidden' },
    ],
    [
      { admin: { role: 'HQ_ADMIN', isActive: false } },
      { operation: 'INCREASE', quantity: 1 },
      { kind: 'forbidden' },
    ],
  ] as const)('refuses %j %j without writing', async (state, adjustment, expected) => {
    const db = fake(state);
    await expect(adjust(db, adjustment)).resolves.toEqual(expected);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('does not lock the assignment when the outlet is inactive', async () => {
    const db = fake({ outlet: { isActive: false } });
    await adjust(db, { operation: 'INCREASE', quantity: 1 });
    expect(db.calls).toEqual(['lock-user-share', 'lock-outlet-share']);
  });

  it('propagates write failures so the transaction rolls back', async () => {
    const db = fake({ stock: 10 });
    db.update.mockRejectedValueOnce(new Error('check constraint violated'));
    await expect(adjust(db, { operation: 'DECREASE', quantity: 1 })).rejects.toThrow(
      'check constraint',
    );
  });
});

describe('InventoryRepository.list (mocked Prisma client)', () => {
  it.each([
    ['out_of_stock', { equals: 0 }],
    ['low', { gte: 1, lte: 10 }],
    ['in_stock', { gt: 10 }],
  ] as const)('filters %s in the query and the count', async (stockStatus, filter) => {
    const db = fake({});
    await new InventoryRepository(db.database).list(
      'o',
      { page: 1, limit: 20, status: 'all', stockStatus, sortBy: 'stockQuantity', sortOrder: 'asc' },
      { kind: 'member', userId: 'u' },
    );
    const where = {
      AND: [
        {
          outletId: 'o',
          isActive: true,
          menuItem: { isActive: true },
          outlet: { isActive: true, memberships: { some: { userId: 'u' } } },
        },
        { stockQuantity: filter },
      ],
    };
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ stockQuantity: 'asc' }, { menuItemId: 'asc' }],
      }),
    );
    expect(db.count).toHaveBeenCalledWith({ where });
  });
});
