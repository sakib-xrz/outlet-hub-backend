import { z } from 'zod';

export const STAFF_PASSWORD_MIN_LENGTH = 12;
export const STAFF_PASSWORD_MAX_LENGTH = 128;
export const MAX_OUTLETS_PER_REQUEST = 200;
export const STAFF_SORT_FIELDS = ['email', 'createdAt', 'updatedAt'] as const;

const email = z
  .string()
  .trim()
  .toLowerCase()
  .pipe(z.email('Enter a valid email address').max(320, 'Email must be at most 320 characters'));

const password = z
  .string()
  .min(
    STAFF_PASSWORD_MIN_LENGTH,
    `Password must be at least ${STAFF_PASSWORD_MIN_LENGTH} characters`,
  )
  .max(
    STAFF_PASSWORD_MAX_LENGTH,
    `Password must be at most ${STAFF_PASSWORD_MAX_LENGTH} characters`,
  )
  .refine((value) => value.trim().length >= STAFF_PASSWORD_MIN_LENGTH, {
    error: 'Password must not be mostly whitespace',
  });

const outletIds = z
  .array(z.uuid('Invalid outlet id'))
  .max(
    MAX_OUTLETS_PER_REQUEST,
    `At most ${MAX_OUTLETS_PER_REQUEST} outlets can be assigned at once`,
  )
  .refine((ids) => new Set(ids).size === ids.length, { error: 'Outlet ids must be unique' });

export const staffParamsSchema = z.object({ staffId: z.uuid('Invalid staff id') });

export const createStaffSchema = z
  .object({ email, password, outletIds: outletIds.default([]) })
  .strict()
  .refine((value) => value.password.toLowerCase() !== value.email, {
    path: ['password'],
    error: 'Password must not be the email address',
  });

export const updateStaffSchema = z.object({ email }).strict();

export const updateStaffStatusSchema = z.object({ isActive: z.boolean() }).strict();

export const replaceStaffOutletsSchema = z.object({ outletIds }).strict();

export const resetStaffPasswordSchema = z.object({ newPassword: password }).strict();

export const staffListQuerySchema = z
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
    outletId: z.uuid('Invalid outlet id').optional(),
    sortBy: z.enum(STAFF_SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict();
