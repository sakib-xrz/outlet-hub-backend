import { z } from 'zod';
import { moneySchema } from '@/common/money.js';
import { MAX_INT } from '@/modules/sales/sale-calculation.js';

export const MAX_SALE_LINES = 100;
export const SALE_SORT_FIELDS = ['createdAt', 'receiptNumber', 'totalAmount'] as const;
const MAX_DATE_RANGE_DAYS = 366;

const uuid = (message: string): z.ZodType<string, string> =>
  z.uuid(message).transform((value) => value.toLowerCase());

export const saleOutletParamsSchema = z.object({ outletId: uuid('Invalid outlet id') });

export const saleParamsSchema = z.object({
  outletId: uuid('Invalid outlet id'),
  saleId: uuid('Invalid sale id'),
});

export const saleRequestParamsSchema = z.object({
  outletId: uuid('Invalid outlet id'),
  requestId: uuid('Invalid request id'),
});

export const createSaleSchema = z
  .object({
    requestId: uuid('requestId must be a UUID'),
    items: z
      .array(
        z
          .object({
            menuItemId: uuid('Invalid menu item id'),
            quantity: z
              .number({ error: 'Quantity must be a whole number' })
              .int('Quantity must be a whole number')
              .min(1, 'Quantity must be at least 1')
              .max(MAX_INT, `Quantity must be at most ${MAX_INT}`),
            expectedUnitPrice: moneySchema,
          })
          .strict(),
      )
      .min(1, 'A sale needs at least one item')
      .max(MAX_SALE_LINES, `A sale can contain at most ${MAX_SALE_LINES} entries`),
  })
  .strict();

export const saleListQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .trim()
      .max(40, 'Search must be at most 40 characters')
      .transform((value) => value || undefined)
      .pipe(
        z
          .string()
          .regex(/\d$/, 'Search by receipt number, e.g. 101 or MIRPUR-01-000101')
          .transform((value) => Number(/(\d{1,10})$/.exec(value)?.[1]))
          .pipe(z.number().int().min(1).max(MAX_INT, 'Receipt number is out of range'))
          .optional(),
      )
      .optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    sortBy: z.enum(SALE_SORT_FIELDS).default('createdAt'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.from || !value.to) return;
    const from = Date.parse(value.from);
    const to = Date.parse(value.to);
    if (to <= from) {
      context.addIssue({ code: 'custom', path: ['to'], message: '`to` must be after `from`' });
    } else if (to - from > MAX_DATE_RANGE_DAYS * 86_400_000) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: `The date range can span at most ${MAX_DATE_RANGE_DAYS} days`,
      });
    }
  });
