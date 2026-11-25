import { createHash } from 'node:crypto';

export const MAX_INT = 2_147_483_647;
export const MAX_UNIT_PRICE_CENTS = 999_999_999_999n;
export const MAX_TOTAL_CENTS = 9_999_999_999_999_999n;

const STORED_MONEY = /^(0|[1-9]\d{0,13})\.(\d{2})$/;

export type SaleItemRequest = { menuItemId: string; quantity: number; expectedUnitPrice: string };

export type NormalizedSaleItem = SaleItemRequest;

export type NormalizationResult =
  | { kind: 'ok'; items: NormalizedSaleItem[] }
  | { kind: 'invalid'; menuItemId: string; message: string };

export function normalizeSaleItems(items: readonly SaleItemRequest[]): NormalizationResult {
  const byId = new Map<string, NormalizedSaleItem>();
  for (const item of items) {
    const id = item.menuItemId.toLowerCase();
    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, { ...item, menuItemId: id });
      continue;
    }
    if (existing.expectedUnitPrice !== item.expectedUnitPrice) {
      return {
        kind: 'invalid',
        menuItemId: id,
        message: 'The same item appears with different expected prices',
      };
    }
    const quantity = existing.quantity + item.quantity;
    if (quantity > MAX_INT) {
      return { kind: 'invalid', menuItemId: id, message: 'Combined quantity is too large' };
    }
    byId.set(id, { ...existing, quantity });
  }
  const sorted = [...byId.values()].sort((a, b) =>
    a.menuItemId < b.menuItemId ? -1 : a.menuItemId > b.menuItemId ? 1 : 0,
  );
  return { kind: 'ok', items: sorted };
}

export function hashSaleRequest(items: readonly NormalizedSaleItem[]): string {
  const canonical = JSON.stringify([
    'sale-request-v1',
    items.map(({ menuItemId, quantity, expectedUnitPrice }) => [
      menuItemId,
      quantity,
      expectedUnitPrice,
    ]),
  ]);
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function parseStoredMoney(value: string): bigint {
  const match = STORED_MONEY.exec(value);
  if (!match) throw new Error(`Corrupted monetary value in the database: ${value}`);
  return BigInt(`${match[1] ?? '0'}${match[2] ?? '00'}`);
}

export function formatCents(cents: bigint): string {
  const negative = cents < 0n;
  const digits = (negative ? -cents : cents).toString().padStart(3, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

export type PricedLine = {
  menuItemId: string;
  itemName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type PricingResult =
  { kind: 'ok'; lines: PricedLine[]; totalAmount: string } | { kind: 'limit-exceeded' };

export function priceLines(
  lines: readonly { menuItemId: string; itemName: string; quantity: number; unitPrice: string }[],
): PricingResult {
  let total = 0n;
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const unit = parseStoredMoney(line.unitPrice);
    if (unit > MAX_UNIT_PRICE_CENTS) throw new Error('Unit price exceeds DECIMAL(12,2)');
    const lineTotal = unit * BigInt(line.quantity);
    if (lineTotal > MAX_TOTAL_CENTS) return { kind: 'limit-exceeded' };
    total += lineTotal;
    if (total > MAX_TOTAL_CENTS) return { kind: 'limit-exceeded' };
    priced.push({ ...line, unitPrice: formatCents(unit), lineTotal: formatCents(lineTotal) });
  }
  const check = priced.reduce((sum, line) => sum + parseStoredMoney(line.lineTotal), 0n);
  if (check !== total) throw new Error('Sale total does not equal the sum of its lines');
  return { kind: 'ok', lines: priced, totalAmount: formatCents(total) };
}

export function receiptCode(outletCode: string, receiptNumber: number): string {
  return `${outletCode}-${String(receiptNumber).padStart(6, '0')}`;
}
