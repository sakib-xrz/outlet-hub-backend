import { z } from 'zod';

export const LOW_STOCK_THRESHOLD = 10;
export const MAX_STOCK_QUANTITY = 2_147_483_647;
export const INVENTORY_SORT_FIELDS = ['sku', 'name', 'stockQuantity', 'updatedAt'] as const;

const positiveQuantity = z
  .number({ error: 'Quantity must be a whole number' })
  .int('Quantity must be a whole number')
  .min(1, 'Quantity must be at least 1')
  .max(MAX_STOCK_QUANTITY, `Quantity must be at most ${MAX_STOCK_QUANTITY}`);

const nonNegativeQuantity = z
  .number({ error: 'Quantity must be a whole number' })
  .int('Quantity must be a whole number')
  .min(0, 'Quantity cannot be negative')
  .max(MAX_STOCK_QUANTITY, `Quantity must be at most ${MAX_STOCK_QUANTITY}`);

export const inventoryParamsSchema = z.object({
  outletId: z.uuid('Invalid outlet id'),
  menuItemId: z.uuid('Invalid menu item id'),
});

export const stockAdjustmentSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('INCREASE'), quantity: positiveQuantity }).strict(),
  z.object({ operation: z.literal('DECREASE'), quantity: positiveQuantity }).strict(),
  z
    .object({
      operation: z.literal('SET'),
      quantity: nonNegativeQuantity,
      expectedStockQuantity: nonNegativeQuantity,
    })
    .strict(),
]);

export const inventoryListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .trim()
      .max(100, 'Search must be at most 100 characters')
      .transform((value) => value || undefined)
      .optional(),
    status: z.enum(['all', 'active', 'inactive']).default('all'),
    stockStatus: z.enum(['all', 'out_of_stock', 'low', 'in_stock']).default('all'),
    sortBy: z.enum(INVENTORY_SORT_FIELDS).default('name'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
