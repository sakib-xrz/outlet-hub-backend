import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import {
  OutletMenuItemRepository,
  toOutletMenuItem,
} from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';

type Rows = {
  admin?: { role: string; isActive: boolean } | null;
  outlet?: { isActive: boolean } | null;
  assignment?: { isActive: boolean } | null;
  menuItem?: { isActive: boolean } | null;
};

type Fake = {
  database: DatabaseClient;
  calls: string[];
  create: Mock;
  update: Mock;
  findMany: Mock;
  count: Mock;
};

function fake(rows: Rows = {}): Fake {
  const calls: string[] = [];
  const state = {
    admin: rows.admin === undefined ? { role: 'HQ_ADMIN', isActive: true } : rows.admin,
    outlet: rows.outlet === undefined ? { isActive: true } : rows.outlet,
    assignment: rows.assignment === undefined ? null : rows.assignment,
    menuItem: rows.menuItem === undefined ? { isActive: true } : rows.menuItem,
  };
  const queryRaw = vi.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM users')) {
      calls.push(sql.includes('FOR SHARE') ? 'lock-admin-share' : 'lock-admin-update');
      return Promise.resolve(
        state.admin
          ? [
              {
                id: 'admin',
                role: state.admin.role,
                is_active: state.admin.isActive,
                password_hash: 'h',
              },
            ]
          : [],
      );
    }
    if (sql.includes('FROM outlet_menu_items')) {
      calls.push(sql.includes('FOR UPDATE') ? 'lock-assignment-update' : 'lock-assignment');
      return Promise.resolve(state.assignment ? [{ is_active: state.assignment.isActive }] : []);
    }
    if (sql.includes('FROM outlets')) {
      calls.push(sql.includes('FOR SHARE') ? 'lock-outlet-share' : 'lock-outlet');
      return Promise.resolve(state.outlet ? [{ is_active: state.outlet.isActive }] : []);
    }
    calls.push(sql.includes('FOR SHARE') ? 'lock-menu-item-share' : 'lock-menu-item');
    return Promise.resolve(state.menuItem ? [{ is_active: state.menuItem.isActive }] : []);
  });
  const create = vi.fn(() => {
    calls.push('create');
    return Promise.resolve({});
  });
  const update = vi.fn(() => {
    calls.push('update');
    return Promise.resolve({});
  });
  const findMany = vi.fn(() => Promise.resolve([]));
  const count = vi.fn(() => Promise.resolve(0));
  const transaction = { $queryRaw: queryRaw, outletMenuItem: { create, update } };
  const database = {
    $transaction: vi.fn((arg: unknown) =>
      typeof arg === 'function'
        ? (arg as (tx: typeof transaction) => Promise<unknown>)(transaction)
        : Promise.all(arg as Promise<unknown>[]),
    ),
    outletMenuItem: { findMany, count },
  } as unknown as DatabaseClient;
  return { database, calls, create, update, findMany, count };
}

const repo = (db: Fake): OutletMenuItemRepository => new OutletMenuItemRepository(db.database);

function row(overrides: {
  overridePrice?: string | null;
  basePrice?: string;
  stock?: number;
  isActive?: boolean;
  outletActive?: boolean;
  menuActive?: boolean;
}): Parameters<typeof toOutletMenuItem>[0] {
  return {
    outletId: 'o',
    menuItemId: 'm',
    overridePrice:
      overrides.overridePrice === undefined || overrides.overridePrice === null
        ? null
        : new Prisma.Decimal(overrides.overridePrice),
    stockQuantity: overrides.stock ?? 5,
    isActive: overrides.isActive ?? true,
    createdAt: new Date(),
    updatedAt: new Date(),
    outlet: { isActive: overrides.outletActive ?? true },
    menuItem: {
      sku: 'B-1',
      name: 'Burger',
      description: null,
      basePrice: new Prisma.Decimal(overrides.basePrice ?? '250'),
      isActive: overrides.menuActive ?? true,
    },
  };
}

describe('effective price and availability mapping', () => {
  it('falls back to the base price when there is no override', () => {
    expect(toOutletMenuItem(row({}))).toMatchObject({
      basePrice: '250.00',
      overridePrice: null,
      effectivePrice: '250.00',
      priceSource: 'BASE',
    });
  });

  it('uses an override, including an explicit zero', () => {
    expect(toOutletMenuItem(row({ overridePrice: '280' }))).toMatchObject({
      effectivePrice: '280.00',
      priceSource: 'OVERRIDE',
    });
    expect(toOutletMenuItem(row({ overridePrice: '0' }))).toMatchObject({
      overridePrice: '0.00',
      effectivePrice: '0.00',
      priceSource: 'OVERRIDE',
    });
  });

  it.each([
    [{}, true, true],
    [{ stock: 0 }, true, false],
    [{ isActive: false }, false, false],
    [{ outletActive: false }, false, false],
    [{ menuActive: false }, false, false],
  ])('%j → enabled %s, sellable %s', (overrides, enabled, sellable) => {
    expect(toOutletMenuItem(row(overrides))).toMatchObject({
      isEnabled: enabled,
      isSellable: sellable,
    });
  });
});

describe('listing (mocked Prisma client)', () => {
  it('builds the staff restriction into the query and the count', async () => {
    const db = fake();
    await repo(db).list(
      'o',
      { page: 2, limit: 10, status: 'all', sortBy: 'name', sortOrder: 'asc', search: 'bur' },
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
        {
          menuItem: {
            OR: [
              { sku: { contains: 'bur', mode: 'insensitive' } },
              { name: { contains: 'bur', mode: 'insensitive' } },
            ],
          },
        },
      ],
    };
    expect(db.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ menuItem: { name: 'asc' } }, { menuItemId: 'asc' }],
        skip: 10,
        take: 10,
      }),
    );
    expect(db.count).toHaveBeenCalledWith({ where });
  });

  it('shows HQ admins every assignment of the outlet', async () => {
    const db = fake();
    await repo(db).list(
      'o',
      { page: 1, limit: 20, status: 'inactive', sortBy: 'createdAt', sortOrder: 'desc' },
      { kind: 'all' },
    );
    expect(db.count).toHaveBeenCalledWith({
      where: { AND: [{ outletId: 'o' }, { isActive: false }] },
    });
  });
});

describe('assignment writes (mocked transaction orchestration)', () => {
  it('locks admin → outlet → assignment → master item, then creates with zero stock', async () => {
    const db = fake();
    await expect(repo(db).assign('admin', 'o', 'm', '280.00')).resolves.toEqual({ kind: 'ok' });
    expect(db.calls).toEqual([
      'lock-admin-share',
      'lock-outlet-share',
      'lock-assignment-update',
      'lock-menu-item-share',
      'create',
    ]);
    expect(db.create).toHaveBeenCalledWith({
      data: {
        outletId: 'o',
        menuItemId: 'm',
        overridePrice: '280.00',
        stockQuantity: 0,
        isActive: true,
      },
    });
  });

  it.each([
    [{ admin: { role: 'OUTLET_STAFF', isActive: true } }, 'forbidden'],
    [{ admin: { role: 'HQ_ADMIN', isActive: false } }, 'forbidden'],
    [{ outlet: null }, 'outlet-not-found'],
    [{ outlet: { isActive: false } }, 'outlet-inactive'],
    [{ menuItem: null }, 'menu-item-not-found'],
    [{ menuItem: { isActive: false } }, 'menu-item-inactive'],
  ] as [Rows, string][])('refuses assignment for %j', async (rows, kind) => {
    const db = fake(rows);
    await expect(repo(db).assign('admin', 'o', 'm', null)).resolves.toMatchObject({ kind });
    expect(db.create).not.toHaveBeenCalled();
  });

  it('reports existing assignments instead of creating duplicates', async () => {
    const db = fake({ assignment: { isActive: false } });
    await expect(repo(db).assign('admin', 'o', 'm', null)).resolves.toEqual({
      kind: 'already-assigned',
      isActive: false,
    });
    expect(db.create).not.toHaveBeenCalled();
  });

  it('updates only the override price, even on inactive outlets and assignments', async () => {
    const db = fake({ outlet: { isActive: false }, assignment: { isActive: false } });
    await expect(repo(db).setOverridePrice('admin', 'o', 'm', null)).resolves.toEqual({
      kind: 'ok',
    });
    expect(db.update).toHaveBeenCalledWith({
      where: { outletId_menuItemId: { outletId: 'o', menuItemId: 'm' } },
      data: { overridePrice: null },
    });
    expect(db.calls).toEqual([
      'lock-admin-share',
      'lock-outlet-share',
      'lock-assignment-update',
      'update',
    ]);
  });

  it('allows deactivation under an inactive parent without locking the master item', async () => {
    const db = fake({
      outlet: { isActive: false },
      assignment: { isActive: true },
      menuItem: { isActive: false },
    });
    await expect(repo(db).setActive('admin', 'o', 'm', false)).resolves.toEqual({ kind: 'ok' });
    expect(db.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isActive: false } }));
    expect(db.calls).not.toContain('lock-menu-item-share');
  });

  it('requires active parents to reactivate and preserves stock and overrides', async () => {
    const outletDown = fake({ outlet: { isActive: false }, assignment: { isActive: false } });
    await expect(repo(outletDown).setActive('admin', 'o', 'm', true)).resolves.toEqual({
      kind: 'outlet-inactive',
    });
    const itemDown = fake({ assignment: { isActive: false }, menuItem: { isActive: false } });
    await expect(repo(itemDown).setActive('admin', 'o', 'm', true)).resolves.toEqual({
      kind: 'menu-item-inactive',
    });
    expect(itemDown.update).not.toHaveBeenCalled();

    const ok = fake({ assignment: { isActive: false } });
    await repo(ok).setActive('admin', 'o', 'm', true);
    expect(ok.update).toHaveBeenCalledWith(expect.objectContaining({ data: { isActive: true } }));
  });

  it('is idempotent: no write when the status is unchanged', async () => {
    const db = fake({ assignment: { isActive: true } });
    await repo(db).setActive('admin', 'o', 'm', true);
    expect(db.update).not.toHaveBeenCalled();
  });

  it('never writes stock, sales, or the master item', async () => {
    const db = fake({ assignment: { isActive: false } });
    await repo(db).setActive('admin', 'o', 'm', true);
    await repo(db).setOverridePrice('admin', 'o', 'm', '1.00');
    for (const [args] of db.update.mock.calls as [{ data: object }][]) {
      expect(Object.keys(args.data)).not.toContain('stockQuantity');
    }
  });
});
