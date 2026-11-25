import type { z } from 'zod';
import type { NormalizedSaleItem } from '@/modules/sales/sale-calculation.js';
import type { createSaleSchema, saleListQuerySchema } from '@/modules/sales/sale.validation.js';

export type SaleLine = {
  menuItemId: string;
  itemName: string;
  quantity: number;
  unitPrice: string;
  lineTotal: string;
};

export type Sale = {
  id: string;
  outletId: string;
  outletCode: string;
  outletName: string;
  receiptNumber: number;
  receiptCode: string;
  requestId: string;
  createdById: string;
  totalAmount: string;
  createdAt: Date;
  items: SaleLine[];
};

export type SaleSummary = {
  id: string;
  receiptNumber: number;
  receiptCode: string;
  totalAmount: string;
  lineCount: number;
  unitCount: number;
  createdById: string;
  createdAt: Date;
};

export type CreateSaleInput = z.infer<typeof createSaleSchema>;
export type SaleListQuery = z.infer<typeof saleListQuerySchema>;
export type SaleScope = { kind: 'all' } | { kind: 'member'; userId: string };

export type CreateSaleCommand = {
  userId: string;
  outletId: string;
  requestId: string;
  requestHash: string;
  items: NormalizedSaleItem[];
};

export type CreateSaleOutcome =
  | { kind: 'created'; saleId: string }
  | { kind: 'replay'; saleId: string }
  | { kind: 'forbidden' }
  | { kind: 'outlet-not-found' }
  | { kind: 'outlet-inactive' }
  | { kind: 'counter-missing' }
  | { kind: 'idempotency-conflict' }
  | { kind: 'unavailable'; items: { menuItemId: string; reason: string }[] }
  | {
      kind: 'insufficient';
      items: { menuItemId: string; requestedQuantity: number; availableQuantity: number }[];
    }
  | {
      kind: 'price-changed';
      items: { menuItemId: string; expectedUnitPrice: string; currentUnitPrice: string }[];
    }
  | { kind: 'total-limit' }
  | { kind: 'receipt-limit' };
