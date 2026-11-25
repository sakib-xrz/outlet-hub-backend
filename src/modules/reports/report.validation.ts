import { z } from 'zod';

export const MAX_REPORT_RANGE_DAYS = 366;
export const REVENUE_SORT_FIELDS = ['totalRevenue', 'totalSales', 'code'] as const;

const timestamp = z.iso.datetime({
  offset: true,
  error: 'Use an ISO 8601 timestamp with a timezone',
});

function refineRange(
  value: { from?: string | undefined; to?: string | undefined },
  context: z.RefinementCtx,
): void {
  if (!value.from !== !value.to) {
    context.addIssue({
      code: 'custom',
      path: [value.from ? 'to' : 'from'],
      message: 'Provide both from and to, or neither',
    });
    return;
  }
  if (!value.from || !value.to) return;
  const from = Date.parse(value.from);
  const to = Date.parse(value.to);
  if (to <= from) {
    context.addIssue({ code: 'custom', path: ['to'], message: '`to` must be after `from`' });
  } else if (to - from > MAX_REPORT_RANGE_DAYS * 86_400_000) {
    context.addIssue({
      code: 'custom',
      path: ['to'],
      message: `The range can span at most ${MAX_REPORT_RANGE_DAYS} days`,
    });
  }
}

export const reportRangeQuerySchema = z
  .object({ from: timestamp.optional(), to: timestamp.optional() })
  .strict()
  .superRefine(refineRange);

export const revenueByOutletQuerySchema = z
  .object({
    from: timestamp.optional(),
    to: timestamp.optional(),
    page: z.coerce.number().int().min(1).max(100_000).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    search: z
      .string()
      .trim()
      .max(100, 'Search must be at most 100 characters')
      .transform((value) => value || undefined)
      .optional(),
    sortBy: z.enum(REVENUE_SORT_FIELDS).default('totalRevenue'),
    sortOrder: z.enum(['asc', 'desc']).default('desc'),
  })
  .strict()
  .superRefine(refineRange);

export const reportOutletParamsSchema = z.object({ outletId: z.uuid('Invalid outlet id') });
