import { describe, expect, it } from 'vitest';
import { moneySchema, serializeMoney } from '@/common/money.js';
import { Prisma } from '@/generated/prisma/client.js';

describe('moneySchema', () => {
  it.each([
    ['0', '0.00'],
    ['0.5', '0.50'],
    ['250', '250.00'],
    ['250.5', '250.50'],
    ['250.05', '250.05'],
    ['9999999999.99', '9999999999.99'],
  ])('normalizes %s to %s without floating point', (input, expected) => {
    expect(moneySchema.parse(input)).toBe(expected);
  });

  it.each([
    '-1',
    '-0.01',
    '1.234',
    '0.001',
    '10000000000',
    '1e3',
    '1E-2',
    'NaN',
    'Infinity',
    '-Infinity',
    '+5',
    '05',
    '5.',
    '.5',
    ' 5',
    '5,00',
    '0x10',
    '',
  ])('rejects %j', (input) => {
    expect(moneySchema.safeParse(input).success).toBe(false);
  });

  it.each([250, 0, Number.NaN, null, true])('rejects non-string value %j', (input) => {
    expect(moneySchema.safeParse(input).success).toBe(false);
  });

  it('keeps cents exact where binary floating point would not', () => {
    expect(moneySchema.parse('0.10')).toBe('0.10');
    expect(serializeMoney(new Prisma.Decimal('0.1').plus('0.2'))).toBe('0.30');
  });
});

describe('serializeMoney', () => {
  it('always emits two fraction digits', () => {
    expect(serializeMoney(new Prisma.Decimal('250'))).toBe('250.00');
    expect(serializeMoney(new Prisma.Decimal('9999999999.99'))).toBe('9999999999.99');
    expect(serializeMoney(new Prisma.Decimal('0'))).toBe('0.00');
  });
});
