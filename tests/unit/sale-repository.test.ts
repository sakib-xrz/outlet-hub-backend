import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { MAX_INT } from '@/modules/sales/sale-calculation.js';
import { SaleRepository } from '@/modules/sales/sale.repository.js';
import type { CreateSaleCommand, CreateSaleOutcome } from '@/modules/sales/sale.types.js';

const USER = 'user-1';
const OUTLET = 'outlet-1';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

type Assignment = {
  menu_item_id: string;
  is_active: boolean;
  stock_quantity: number;
  override_price: string | null;
};
type Master = { id: string; name: string; base_price: string; is_active: boolean };

type State = {
  user?: { role: string; isActive: boolean } | null;
  member?: boolean;
  outlet?: { isActive: boolean } | null;
  counter?: number | null;
  existing?: { id: string; createdById: string; requestHash: string } | null;
  assignments?: Assignment[];
  masters?: Master[];
};

type Fake = {
  database: DatabaseClient;
  calls: string[];
  deduct: Mock;
  saleCreate: Mock;
  itemsCreate: Mock;
  increments: Mock;
};

const assignment = (
  id: string,
  stock: number,
  override: string | null = null,
  active = true,
): Assignment => ({
  menu_item_id: id,
  is_active: active,
  stock_quantity: stock,
  override_price: override,
});
const master = (id: string, name: string, price: string, active = true): Master => ({
  id,
  name,
  base_price: price,
  is_active: active,
});

function fake(state: State = {}): Fake {
  const calls: string[] = [];
  const user = state.user === undefined ? { role: 'OUTLET_STAFF', isActive: true } : state.user;
  const outlet = state.outlet === undefined ? { isActive: true } : state.outlet;
  const counter = state.counter === undefined ? 100 : state.counter;
  const increments = vi.fn(() => [{ last_number: (counter ?? 0) + 1 }]);
  const queryRaw = vi.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM users')) {
      calls.push('lock-user-share');
      return Promise.resolve(
        user ? [{ id: USER, role: user.role, is_active: user.isActive, password_hash: 'h' }] : [],
      );
    }
    if (sql.includes('UPDATE receipt_counters')) {
      calls.push('increment-counter');
      return Promise.resolve(increments());
    }
    if (sql.includes('FROM receipt_counters')) {
      calls.push(sql.includes('FOR UPDATE') ? 'lock-counter-update' : 'lock-counter');
      return Promise.resolve(counter === null ? [] : [{ last_number: counter }]);
    }
    if (sql.includes('FROM outlet_menu_items')) {
      calls.push(
        sql.includes('ORDER BY menu_item_id') && sql.includes('FOR UPDATE')
          ? 'lock-assignments-update'
          : 'lock-assignments',
      );
      return Promise.resolve(state.assignments ?? [assignment(A, 10), assignment(B, 10)]);
    }
    if (sql.includes('FROM menu_items')) {
      calls.push(
        sql.includes('ORDER BY id') && sql.includes('FOR SHARE')
          ? 'lock-masters-share'
          : 'lock-masters',
      );
      return Promise.resolve(
        state.masters ?? [master(A, 'Burger', '250.00'), master(B, 'Fries', '100.00')],
      );
    }
    calls.push(sql.includes('FOR SHARE') ? 'lock-outlet-share' : 'lock-outlet');
    return Promise.resolve(outlet ? [{ is_active: outlet.isActive }] : []);
  });
  const record = (name: string, value: unknown): Mock =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const deduct = record('deduct', { count: 1 });
  const saleCreate = record('create-sale', { id: 'sale-1' });
  const itemsCreate = record('create-items', { count: 2 });
  const transaction = {
    $queryRaw: queryRaw,
    outletMembership: {
      findUnique: record('membership', state.member === false ? null : { outletId: OUTLET }),
    },
    sale: { findUnique: record('find-existing', state.existing ?? null), create: saleCreate },
    saleItem: { createMany: itemsCreate },
    outletMenuItem: { updateMany: deduct },
  };
  const database = {
    $transaction: vi.fn(
      (callback: (tx: typeof transaction) => Promise<unknown>, options: unknown) => {
        calls.push(`begin:${JSON.stringify(options)}`);
        return callback(transaction);
      },
    ),
  } as unknown as DatabaseClient;
  return { database, calls, deduct, saleCreate, itemsCreate, increments };
}

const command = (
  items = [
    { menuItemId: A, quantity: 2, expectedUnitPrice: '250.00' },
    { menuItemId: B, quantity: 3, expectedUnitPrice: '100.00' },
  ],
): CreateSaleCommand => ({
  userId: USER,
  outletId: OUTLET,
  requestId: 'req-1',
  requestHash: 'h'.repeat(64),
  items,
});

const create = (db: Fake, cmd = command()): Promise<CreateSaleOutcome> =>
  new SaleRepository(db.database).createSale(cmd);

describe('SaleRepository.createSale (mocked transaction orchestration)', () => {
  it('follows the global lock order, then writes stock, counter, sale and lines', async () => {
    const db = fake();
    await expect(create(db)).resolves.toEqual({ kind: 'created', saleId: 'sale-1' });
    expect(db.calls).toEqual([
      'begin:{"isolationLevel":"ReadCommitted"}',
      'lock-user-share',
      'membership',
      'lock-outlet-share',
      'lock-counter-update',
      'find-existing',
      'lock-assignments-update',
      'lock-masters-share',
      'deduct',
      'deduct',
      'increment-counter',
      'create-sale',
      'create-items',
    ]);
  });

  it('deducts with guarded conditional updates in menu item order', async () => {
    const db = fake();
    await create(db);
    expect(db.deduct.mock.calls).toEqual([
      [
        {
          where: { outletId: OUTLET, menuItemId: A, stockQuantity: { gte: 2 } },
          data: { stockQuantity: { decrement: 2 } },
        },
      ],
      [
        {
          where: { outletId: OUTLET, menuItemId: B, stockQuantity: { gte: 3 } },
          data: { stockQuantity: { decrement: 3 } },
        },
      ],
    ]);
  });

  it('persists server-side snapshots, exact totals and the next receipt number', async () => {
    const db = fake({ counter: 100 });
    await create(db);
    expect(db.saleCreate).toHaveBeenCalledWith({
      data: {
        outletId: OUTLET,
        createdById: USER,
        receiptNumber: 101,
        requestId: 'req-1',
        requestHash: 'h'.repeat(64),
        totalAmount: '800.00',
      },
      select: { id: true },
    });
    expect(db.itemsCreate).toHaveBeenCalledWith({
      data: [
        {
          saleId: 'sale-1',
          outletId: OUTLET,
          menuItemId: A,
          itemName: 'Burger',
          quantity: 2,
          unitPrice: '250.00',
          lineTotal: '500.00',
        },
        {
          saleId: 'sale-1',
          outletId: OUTLET,
          menuItemId: B,
          itemName: 'Fries',
          quantity: 3,
          unitPrice: '100.00',
          lineTotal: '300.00',
        },
      ],
    });
  });

  it('uses override prices, including an explicit zero, over base prices', async () => {
    const db = fake({ assignments: [assignment(A, 10, '280.00'), assignment(B, 10, '0.00')] });
    await create(
      db,
      command([
        { menuItemId: A, quantity: 1, expectedUnitPrice: '280.00' },
        { menuItemId: B, quantity: 2, expectedUnitPrice: '0.00' },
      ]),
    );
    expect(db.saleCreate).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ totalAmount: '280.00' }) }),
    );
  });

  it('allows selling the exact remaining stock', async () => {
    const db = fake({ assignments: [assignment(A, 2), assignment(B, 3)] });
    await expect(create(db)).resolves.toMatchObject({ kind: 'created' });
  });

  it('replays a matching request before checking stock or prices, without writing', async () => {
    const db = fake({
      existing: { id: 'old-sale', createdById: USER, requestHash: 'h'.repeat(64) },
      assignments: [assignment(A, 0), assignment(B, 0)],
    });
    await expect(create(db)).resolves.toEqual({ kind: 'replay', saleId: 'old-sale' });
    expect(db.calls.at(-1)).toBe('find-existing');
    expect(db.deduct).not.toHaveBeenCalled();
    expect(db.increments).not.toHaveBeenCalled();
    expect(db.saleCreate).not.toHaveBeenCalled();
  });

  it.each([
    [
      { existing: { id: 'x', createdById: USER, requestHash: 'z'.repeat(64) } },
      'idempotency-conflict',
    ],
    [
      { existing: { id: 'x', createdById: 'someone-else', requestHash: 'h'.repeat(64) } },
      'idempotency-conflict',
    ],
    [{ user: { role: 'OUTLET_STAFF', isActive: false } }, 'forbidden'],
    [{ user: { role: 'HQ_ADMIN', isActive: true } }, 'forbidden'],
    [{ user: null }, 'forbidden'],
    [{ member: false }, 'forbidden'],
    [{ outlet: null }, 'outlet-not-found'],
    [{ outlet: { isActive: false } }, 'outlet-inactive'],
    [{ counter: null }, 'counter-missing'],
    [{ assignments: [assignment(A, 10)] }, 'unavailable'],
    [{ assignments: [assignment(A, 10, null, false), assignment(B, 10)] }, 'unavailable'],
    [
      { masters: [master(A, 'Burger', '250.00', false), master(B, 'Fries', '100.00')] },
      'unavailable',
    ],
    [{ assignments: [assignment(A, 1), assignment(B, 10)] }, 'insufficient'],
    [{ masters: [master(A, 'Burger', '260.00'), master(B, 'Fries', '100.00')] }, 'price-changed'],
    [{ assignments: [assignment(A, 10, '1.00'), assignment(B, 10)] }, 'price-changed'],
    [{ counter: MAX_INT }, 'receipt-limit'],
  ] as [State, string][])('refuses %j as %s without any write', async (state, kind) => {
    const db = fake(state);
    await expect(create(db)).resolves.toMatchObject({ kind });
    expect(db.deduct).not.toHaveBeenCalled();
    expect(db.increments).not.toHaveBeenCalled();
    expect(db.saleCreate).not.toHaveBeenCalled();
  });

  it('reports item-specific details', async () => {
    const db = fake({
      assignments: [assignment(A, 1), assignment(B, 10)],
      masters: [master(A, 'Burger', '260.00'), master(B, 'Fries', '100.00')],
    });
    await expect(create(db)).resolves.toEqual({
      kind: 'price-changed',
      items: [{ menuItemId: A, expectedUnitPrice: '250.00', currentUnitPrice: '260.00' }],
    });
  });

  it('refuses totals beyond DECIMAL(16,2)', async () => {
    const db = fake({
      assignments: [assignment(A, MAX_INT, '9999999999.99'), assignment(B, 10)],
    });
    await expect(
      create(
        db,
        command([{ menuItemId: A, quantity: MAX_INT, expectedUnitPrice: '9999999999.99' }]),
      ),
    ).resolves.toEqual({ kind: 'total-limit' });
    expect(db.deduct).not.toHaveBeenCalled();
  });

  it('rejects corrupted (NaN) prices read from the database', async () => {
    const db = fake({ assignments: [assignment(A, 10, 'NaN'), assignment(B, 10)] });
    await expect(create(db)).rejects.toThrow('Corrupted monetary value');
    expect(db.deduct).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a guarded deduction that matches no row',
      (db: Fake) => db.deduct.mockResolvedValueOnce({ count: 0 }),
      'Guarded stock deduction failed',
    ],
    [
      'a failure after the counter increment',
      (db: Fake) => db.saleCreate.mockRejectedValueOnce(new Error('sale insert failed')),
      'sale insert failed',
    ],
    [
      'a failure while inserting sale lines',
      (db: Fake) => db.itemsCreate.mockRejectedValueOnce(new Error('line insert failed')),
      'line insert failed',
    ],
  ] as const)(
    'propagates %s so PostgreSQL rolls back every write',
    async (_label, arrange, message) => {
      const db = fake();
      arrange(db);
      await expect(create(db)).rejects.toThrow(message);
    },
  );
});
