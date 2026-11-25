import { describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { SaleRepository } from '@/modules/sales/sale.repository.js';

describe('SaleRepository.list date range', () => {
  it('uses a half-open range so adjacent windows never double-count a sale', async () => {
    const findMany = vi.fn(() => Promise.resolve([]));
    const count = vi.fn(() => Promise.resolve(0));
    const database = {
      $transaction: (operations: Promise<unknown>[]) => Promise.all(operations),
      sale: { findMany, count },
      saleItem: { groupBy: vi.fn(() => Promise.resolve([])) },
    } as unknown as DatabaseClient;
    await new SaleRepository(database).list(
      'outlet-1',
      {
        page: 1,
        limit: 20,
        sortBy: 'createdAt',
        sortOrder: 'desc',
        from: '2026-11-01T00:00:00+06:00',
        to: '2026-11-02T00:00:00+06:00',
      },
      { kind: 'all' },
    );
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-10-31T18:00:00Z'),
            lt: new Date('2026-11-01T18:00:00Z'),
          },
        }),
      }),
    );
  });
});
