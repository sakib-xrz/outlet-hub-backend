import type { z } from 'zod';
import type {
  createOutletSchema,
  outletListQuerySchema,
  updateOutletSchema,
  updateOutletStatusSchema,
} from '@/modules/outlets/outlet.validation.js';

export type Outlet = {
  id: string;
  code: string;
  name: string;
  address: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type CreateOutletInput = z.infer<typeof createOutletSchema>;
export type UpdateOutletInput = z.infer<typeof updateOutletSchema>;
export type UpdateOutletStatusInput = z.infer<typeof updateOutletStatusSchema>;
export type OutletListQuery = z.infer<typeof outletListQuerySchema>;

export type OutletListScope = { kind: 'all' } | { kind: 'member'; userId: string };

export type Paginated<T> = {
  items: T[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
};
