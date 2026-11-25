import { z } from 'zod';
import { moneySchema } from '@/common/money.js';

export const OUTLET_MENU_SORT_FIELDS = ['sku', 'name', 'createdAt', 'updatedAt'] as const;

export const outletMenuParamsSchema = z.object({ outletId: z.uuid('Invalid outlet id') });

export const outletMenuItemParamsSchema = z.object({
  outletId: z.uuid('Invalid outlet id'),
  menuItemId: z.uuid('Invalid menu item id'),
});

export const assignMenuItemSchema = z
  .object({
    menuItemId: z.uuid('Invalid menu item id'),
    overridePrice: moneySchema.nullable().optional().default(null),
  })
  .strict();

export const updateOverridePriceSchema = z
  .object({ overridePrice: moneySchema.nullable() })
  .strict();

export const updateAssignmentStatusSchema = z.object({ isActive: z.boolean() }).strict();

export const outletMenuListQuerySchema = z
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
    sortBy: z.enum(OUTLET_MENU_SORT_FIELDS).default('name'),
    sortOrder: z.enum(['asc', 'desc']).default('asc'),
  })
  .strict();
