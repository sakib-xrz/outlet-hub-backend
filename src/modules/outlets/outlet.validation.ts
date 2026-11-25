import { z } from 'zod';

export const OUTLET_CODE_PATTERN = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
export const OUTLET_SORT_FIELDS = ['code', 'name', 'createdAt', 'updatedAt'] as const;
export const OUTLET_STATUS_FILTERS = ['all', 'active', 'inactive'] as const;

const code = z
  .string()
  .trim()
  .toUpperCase()
  .min(2, 'Code must be at least 2 characters')
  .max(20, 'Code must be at most 20 characters')
  .regex(OUTLET_CODE_PATTERN, 'Code may contain letters, numbers and single hyphens only');

const name = z
  .string()
  .trim()
  .min(1, 'Name is required')
  .max(150, 'Name must be at most 150 characters');

const address = z
  .string()
  .trim()
  .max(500, 'Address must be at most 500 characters')
  .transform((value) => value || null)
  .nullable();

export const outletParamsSchema = z.object({ outletId: z.uuid('Invalid outlet id') });

export const createOutletSchema = z
  .object({ code, name, address: address.optional().default(null) })
  .strict();

export const updateOutletSchema = z
  .object({ name: name.optional(), address: address.optional() })
  .strict()
  .refine((value) => value.name !== undefined || value.address !== undefined, {
    error: 'Provide at least one of name or address',
  });

export const updateOutletStatusSchema = z.object({ isActive: z.boolean() }).strict();

export const outletListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .trim()
      .max(100, 'Search must be at most 100 characters')
      .transform((value) => value || undefined)
      .optional(),
    status: z.enum(OUTLET_STATUS_FILTERS).default('all'),
    sortBy: z.enum(OUTLET_SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
