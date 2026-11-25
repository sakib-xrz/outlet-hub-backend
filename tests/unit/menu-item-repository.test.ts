import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';
import { MenuItemRepository } from '@/modules/menu-items/menu-item.repository.js';

const row = {
  id: 'item-1',
  sku: 'COFFEE-001',
  name: 'Cappuccino',
  description: null,
  basePrice: new Prisma.Decimal('180'),
  isActive: true,
  createdAt: new Date(),
  updatedAt: new Date(),
};

type Fake = {
  database: DatabaseClient;
  menuItem: Record<'findMany' | 'count' | 'findUnique' | 'create' | 'update' | 'updateMany', Mock>;
};

function fake(): Fake {
  const menuItem = {
    findMany: vi.fn(() => Promise.resolve([row])),
    count: vi.fn(() => Promise.resolve(1)),
    findUnique: vi.fn(() => Promise.resolve(row)),
    create: vi.fn(() => Promise.resolve(row)),
    update: vi.fn(() => Promise.resolve(row)),
    updateMany: vi.fn(() => Promise.resolve({ count: 1 })),
  };
  const database = {
    menuItem,
    $transaction: vi.fn((queries: Promise<unknown>[]) => Promise.all(queries)),
  } as unknown as DatabaseClient;
  return { database, menuItem };
}

describe('MenuItemRepository (mocked Prisma client)', () => {
  it('serializes Decimal prices as two-decimal strings', async () => {
    const { database } = fake();
    const result = await new MenuItemRepository(database).findById('item-1');
    expect(result?.basePrice).toBe('180.00');
  });

  it('filters, sorts with a stable tie-breaker, and pages in the database', async () => {
    const { database, menuItem } = fake();
    await new MenuItemRepository(database).list({
      page: 3,
      limit: 10,
      search: 'cof',
      status: 'inactive',
      sortBy: 'basePrice',
      sortOrder: 'desc',
    });
    const where = {
      isActive: false,
      OR: [
        { sku: { contains: 'cof', mode: 'insensitive' } },
        { name: { contains: 'cof', mode: 'insensitive' } },
      ],
    };
    expect(menuItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where,
        orderBy: [{ basePrice: 'desc' }, { id: 'asc' }],
        skip: 20,
        take: 10,
      }),
    );
    expect(menuItem.count).toHaveBeenCalledWith({ where });
  });

  it('creates active items with the price passed as an exact string', async () => {
    const { database, menuItem } = fake();
    await new MenuItemRepository(database).create({
      sku: 'COFFEE-001',
      name: 'Cappuccino',
      description: null,
      basePrice: '0.10',
    });
    expect(menuItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          sku: 'COFFEE-001',
          name: 'Cappuccino',
          description: null,
          basePrice: '0.10',
          isActive: true,
        },
      }),
    );
  });

  it('updates only menu item scalars, never relations or SKU', async () => {
    const { database, menuItem } = fake();
    await new MenuItemRepository(database).update('item-1', { basePrice: '200.00' });
    expect(menuItem.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'item-1' }, data: { basePrice: '200.00' } }),
    );
    const { data } = (menuItem.update.mock.calls[0] as [{ data: object }])[0];
    expect(Object.keys(data)).not.toEqual(expect.arrayContaining(['sku', 'outlets', 'isActive']));
  });

  it('changes status with a conditional update so repeats are no-ops', async () => {
    const { database, menuItem } = fake();
    await new MenuItemRepository(database).setActive('item-1', false);
    expect(menuItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-1', isActive: true },
      data: { isActive: false },
    });
  });

  it('returns null for a missing item after a status change', async () => {
    const { database, menuItem } = fake();
    menuItem.updateMany.mockResolvedValueOnce({ count: 0 });
    menuItem.findUnique.mockResolvedValueOnce(null);
    await expect(new MenuItemRepository(database).setActive('missing', true)).resolves.toBeNull();
  });
});
