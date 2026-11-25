import type { z } from 'zod';
import type {
  assignMenuItemSchema,
  outletMenuListQuerySchema,
  updateAssignmentStatusSchema,
  updateOverridePriceSchema,
} from '@/modules/outlet-menu-items/outlet-menu-item.validation.js';

export type PriceSource = 'BASE' | 'OVERRIDE';

export type OutletMenuItem = {
  outletId: string;
  menuItemId: string;
  sku: string;
  name: string;
  description: string | null;
  basePrice: string;
  overridePrice: string | null;
  effectivePrice: string;
  priceSource: PriceSource;
  stockQuantity: number;
  isActive: boolean;
  outletIsActive: boolean;
  menuItemIsActive: boolean;
  isEnabled: boolean;
  isSellable: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type OutletMenuScope = { kind: 'all' } | { kind: 'member'; userId: string };

export type OutletMenuListQuery = z.infer<typeof outletMenuListQuerySchema>;
export type AssignMenuItemInput = z.infer<typeof assignMenuItemSchema>;
export type UpdateOverridePriceInput = z.infer<typeof updateOverridePriceSchema>;
export type UpdateAssignmentStatusInput = z.infer<typeof updateAssignmentStatusSchema>;

export type AssignmentWriteResult =
  | { kind: 'ok' }
  | { kind: 'forbidden' }
  | { kind: 'outlet-not-found' }
  | { kind: 'outlet-inactive' }
  | { kind: 'assignment-not-found' }
  | { kind: 'already-assigned'; isActive: boolean }
  | { kind: 'menu-item-not-found' }
  | { kind: 'menu-item-inactive' };
