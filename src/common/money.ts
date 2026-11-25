import { z } from 'zod';
import type { Prisma } from '@/generated/prisma/client.js';

export const MONEY_MAX = '9999999999.99';

const MONEY_PATTERN = /^(0|[1-9]\d{0,9})(?:\.(\d{1,2}))?$/;

export function normalizeMoney(value: string): string {
  const match = MONEY_PATTERN.exec(value);
  if (!match) throw new Error('Invalid money value');
  return `${match[1] ?? '0'}.${(match[2] ?? '').padEnd(2, '0')}`;
}

export const moneySchema = z
  .string({ error: 'Must be a decimal string such as "250.00"' })
  .regex(
    MONEY_PATTERN,
    `Must be a non-negative amount with at most 2 decimal places, up to ${MONEY_MAX}`,
  )
  .transform(normalizeMoney);

export function serializeMoney(value: Prisma.Decimal): string {
  return value.toFixed(2);
}
