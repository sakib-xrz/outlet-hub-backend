import { describe, expect, it } from 'vitest';
import {
  formatCents,
  hashSaleRequest,
  MAX_INT,
  type NormalizedSaleItem,
  normalizeSaleItems,
  parseStoredMoney,
  priceLines,
  receiptCode,
} from '@/modules/sales/sale-calculation.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('normalizeSaleItems', () => {
  it('combines duplicates, lowercases ids and sorts by menu item id', () => {
    const result = normalizeSaleItems([
      { menuItemId: B, quantity: 1, expectedUnitPrice: '10.00' },
      { menuItemId: A.toUpperCase(), quantity: 2, expectedUnitPrice: '5.00' },
      { menuItemId: A, quantity: 3, expectedUnitPrice: '5.00' },
    ]);
    expect(result).toEqual({
      kind: 'ok',
      items: [
        { menuItemId: A, quantity: 5, expectedUnitPrice: '5.00' },
        { menuItemId: B, quantity: 1, expectedUnitPrice: '10.00' },
      ],
    });
  });

  it('rejects duplicates with different expected prices', () => {
    expect(
      normalizeSaleItems([
        { menuItemId: A, quantity: 1, expectedUnitPrice: '5.00' },
        { menuItemId: A, quantity: 1, expectedUnitPrice: '6.00' },
      ]),
    ).toMatchObject({ kind: 'invalid', menuItemId: A });
  });

  it('rejects aggregated quantities beyond INTEGER', () => {
    expect(
      normalizeSaleItems([
        { menuItemId: A, quantity: MAX_INT, expectedUnitPrice: '1.00' },
        { menuItemId: A, quantity: 1, expectedUnitPrice: '1.00' },
      ]),
    ).toMatchObject({ kind: 'invalid', message: 'Combined quantity is too large' });
  });
});

describe('hashSaleRequest', () => {
  const normalized = (items: Parameters<typeof normalizeSaleItems>[0]): NormalizedSaleItem[] => {
    const result = normalizeSaleItems(items);
    if (result.kind !== 'ok') throw new Error('unexpected');
    return result.items;
  };

  it('is a deterministic SHA-256 hex digest independent of ordering and splitting', () => {
    const first = hashSaleRequest(
      normalized([
        { menuItemId: A, quantity: 2, expectedUnitPrice: '5.00' },
        { menuItemId: B, quantity: 1, expectedUnitPrice: '10.00' },
      ]),
    );
    const second = hashSaleRequest(
      normalized([
        { menuItemId: B, quantity: 1, expectedUnitPrice: '10.00' },
        { menuItemId: A, quantity: 1, expectedUnitPrice: '5.00' },
        { menuItemId: A, quantity: 1, expectedUnitPrice: '5.00' },
      ]),
    );
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes when quantity or expected price changes', () => {
    const base = hashSaleRequest([{ menuItemId: A, quantity: 2, expectedUnitPrice: '5.00' }]);
    expect(hashSaleRequest([{ menuItemId: A, quantity: 3, expectedUnitPrice: '5.00' }])).not.toBe(
      base,
    );
    expect(hashSaleRequest([{ menuItemId: A, quantity: 2, expectedUnitPrice: '5.01' }])).not.toBe(
      base,
    );
  });
});

describe('exact money arithmetic', () => {
  it('multiplies and sums in integer minor units', () => {
    const result = priceLines([
      { menuItemId: A, itemName: 'Tea', quantity: 3, unitPrice: '0.10' },
      { menuItemId: B, itemName: 'Burger', quantity: 2, unitPrice: '250.00' },
    ]);
    expect(result).toEqual({
      kind: 'ok',
      totalAmount: '500.30',
      lines: [
        { menuItemId: A, itemName: 'Tea', quantity: 3, unitPrice: '0.10', lineTotal: '0.30' },
        {
          menuItemId: B,
          itemName: 'Burger',
          quantity: 2,
          unitPrice: '250.00',
          lineTotal: '500.00',
        },
      ],
    });
  });

  it('keeps zero prices and handles the largest valid line exactly', () => {
    expect(
      priceLines([{ menuItemId: A, itemName: 'Free', quantity: 5, unitPrice: '0.00' }]),
    ).toMatchObject({
      totalAmount: '0.00',
    });
    expect(
      priceLines([{ menuItemId: A, itemName: 'Big', quantity: 10000, unitPrice: '9999999999.99' }]),
    ).toMatchObject({ totalAmount: '99999999999900.00' });
  });

  it('reports DECIMAL(16,2) overflow for a line or the total', () => {
    expect(
      priceLines([{ menuItemId: A, itemName: 'X', quantity: MAX_INT, unitPrice: '9999999999.99' }]),
    ).toEqual({ kind: 'limit-exceeded' });
    expect(
      priceLines([
        { menuItemId: A, itemName: 'X', quantity: 10000, unitPrice: '9999999999.99' },
        { menuItemId: B, itemName: 'Y', quantity: 1, unitPrice: '1000.00' },
      ]),
    ).toEqual({ kind: 'limit-exceeded' });
  });

  it.each(['NaN', 'Infinity', '-1.00', '1.234', '', '1e5'])(
    'rejects corrupted database value %j',
    (value) => {
      expect(() => parseStoredMoney(value)).toThrow('Corrupted monetary value');
    },
  );

  it('formats minor units without floating point', () => {
    expect(formatCents(0n)).toBe('0.00');
    expect(formatCents(5n)).toBe('0.05');
    expect(formatCents(9_999_999_999_999_999n)).toBe('99999999999999.99');
  });
});

describe('receiptCode', () => {
  it('pads to six digits without truncating larger numbers', () => {
    expect(receiptCode('MIRPUR-01', 101)).toBe('MIRPUR-01-000101');
    expect(receiptCode('MIRPUR-01', 12345678)).toBe('MIRPUR-01-12345678');
  });
});
