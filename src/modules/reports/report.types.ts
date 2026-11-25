import type { z } from 'zod';
import type {
  reportRangeQuerySchema,
  revenueByOutletQuerySchema,
} from '@/modules/reports/report.validation.js';

export type DateRange = { from: Date; to: Date } | null;

export type BusinessSummary = {
  totalRevenue: string;
  totalSales: string;
  totalUnitsSold: string;
  totalOutlets: number;
  activeOutlets: number;
};

export type OutletRevenue = {
  outletId: string;
  outletCode: string;
  outletName: string;
  isActive: boolean;
  totalRevenue: string;
  totalSales: string;
};

export type TopSellingItem = {
  rank: number;
  menuItemId: string;
  sku: string;
  name: string;
  quantitySold: string;
  totalRevenue: string;
};

export type ReportOutlet = { id: string; code: string; name: string; isActive: boolean };

export type ReportRangeQuery = z.infer<typeof reportRangeQuerySchema>;
export type RevenueByOutletQuery = z.infer<typeof revenueByOutletQuerySchema>;
