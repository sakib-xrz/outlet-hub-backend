import { z } from 'zod';
import { moneySchema } from '@/common/money.js';

export const MENU_ITEM_SKU_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const MENU_ITEM_SORT_FIELDS = [
  'sku',
  'name',
  'basePrice',
  'createdAt',
  'updatedAt',
] as const;

const sku = z
  .string()
  .trim()
  .toUpperCase()
  .min(1, 'SKU is required')
  .max(50, 'SKU must be at most 50 characters')
  .regex(MENU_ITEM_SKU_PATTERN, 'SKU may contain letters, numbers and single hyphens only');

const name = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(150, 'Name must be at most 150 characters');

const description = z
  .string()
  .trim()
  .max(1000, 'Description must be at most 1000 characters')
  .transform((value) => value || null)
  .nullable();

export const menuItemParamsSchema = z.object({ menuItemId: z.uuid('Invalid menu item id') });

export const createMenuItemSchema = z
  .object({
    sku,
    name,
    description: description.optional().default(null),
    basePrice: moneySchema,
  })
  .strict();

export const updateMenuItemSchema = z
  .object({
    name: name.optional(),
    description: description.optional(),
    basePrice: moneySchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined || value.description !== undefined || value.basePrice !== undefined,
    { error: 'Provide at least one of name, description or basePrice' },
  );

export const updateMenuItemStatusSchema = z.object({ isActive: z.boolean() }).strict();

export const menuItemListQuerySchema = z
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
    sortBy: z.enum(MENU_ITEM_SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
