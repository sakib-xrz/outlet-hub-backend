import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { OutletRepository } from '@/modules/outlets/outlet.repository.js';
import type { OutletListQuery } from '@/modules/outlets/outlet.types.js';

const query: OutletListQuery = {
  page: 2,
  limit: 10,
  search: 'mir',
  status: 'all',
  sortBy: 'name',
  sortOrder: 'asc',
};

type FakeDatabase = {
  database: DatabaseClient;
  findMany: Mock;
  count: Mock;
  outletCreate: Mock;
  receiptCounterCreate: Mock;
  rootOutletCreate: Mock;
};

function fakeDatabase(): FakeDatabase {
  const findMany = vi.fn(() => Promise.resolve([]));
  const count = vi.fn(() => Promise.resolve(0));
  const outletCreate = vi.fn(() => Promise.resolve({ id: 'outlet-1', code: 'A-1' }));
  const receiptCounterCreate = vi.fn(() => Promise.resolve({}));
  const rootOutletCreate = vi.fn();
  const transactionClient = {
    outlet: { create: outletCreate },
    receiptCounter: { create: receiptCounterCreate },
  };
  const $transaction = vi.fn((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: typeof transactionClient) => Promise<unknown>)(transactionClient)
      : Promise.all(arg as Promise<unknown>[]),
  );
  const database = {
    $transaction,
    outlet: { findMany, count, create: rootOutletCreate },
  } as unknown as DatabaseClient;
  return { database, findMany, count, outletCreate, receiptCounterCreate, rootOutletCreate };
}

describe('OutletRepository.list', () => {
  it('applies staff scope, filters and search to both the page and the count', async () => {
    const { database, findMany, count } = fakeDatabase();
    await new OutletRepository(database).list(
      { ...query, status: 'inactive' },
      { kind: 'member', userId: 'user-1' },
    );

    const where = {
      AND: [
        { isActive: true, memberships: { some: { userId: 'user-1' } } },
        { isActive: false },
        {
          OR: [
            { code: { contains: 'mir', mode: 'insensitive' } },
            { name: { contains: 'mir', mode: 'insensitive' } },
          ],
        },
      ],
    };
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: 10,
        take: 10,
      }),
    );
    expect(count).toHaveBeenCalledWith({ where });
  });

  it('does not restrict HQ admin listings', async () => {
    const { database, count } = fakeDatabase();
    await new OutletRepository(database).list({ ...query, search: undefined }, { kind: 'all' });
    expect(count).toHaveBeenCalledWith({ where: { AND: [] } });
  });
});

describe('OutletRepository.createWithReceiptCounter (mocked transaction orchestration)', () => {
  it('creates the outlet and a zeroed receipt counter on the same transaction client', async () => {
    const { database, outletCreate, receiptCounterCreate, rootOutletCreate } = fakeDatabase();
    await new OutletRepository(database).createWithReceiptCounter({
      code: 'A-1',
      name: 'A',
      address: null,
    });
    expect(outletCreate).toHaveBeenCalledOnce();
    expect(receiptCounterCreate).toHaveBeenCalledWith({
      data: { outletId: 'outlet-1', lastNumber: 0 },
    });
    expect(rootOutletCreate).not.toHaveBeenCalled();
  });

  it('propagates a receipt-counter failure so the transaction rolls back', async () => {
    const { database, receiptCounterCreate } = fakeDatabase();
    receiptCounterCreate.mockRejectedValueOnce(new Error('counter failed'));
    await expect(
      new OutletRepository(database).createWithReceiptCounter({
        code: 'A-1',
        name: 'A',
        address: null,
      }),
    ).rejects.toThrow('counter failed');
  });
});
