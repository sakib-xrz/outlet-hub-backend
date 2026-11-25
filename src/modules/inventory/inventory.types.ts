import type { z } from 'zod';
import type {
  inventoryListQuerySchema,
  stockAdjustmentSchema,
} from '@/modules/inventory/inventory.validation.js';

export type StockStatus = 'OUT_OF_STOCK' | 'LOW' | 'IN_STOCK';

export type InventoryItem = {
  outletId: string;
  menuItemId: string;
  sku: string;
  name: string;
  stockQuantity: number;
  stockStatus: StockStatus;
  isActive: boolean;
  outletIsActive: boolean;
  menuItemIsActive: boolean;
  isEnabled: boolean;
  isSellable: boolean;
  updatedAt: Date;
};

export type StockAdjustment = z.infer<typeof stockAdjustmentSchema>;
export type InventoryListQuery = z.infer<typeof inventoryListQuerySchema>;

export type StockAdjustmentResult = {
  inventoryItem: InventoryItem;
  operation: StockAdjustment['operation'];
  previousStockQuantity: number;
  newStockQuantity: number;
  changed: boolean;
};

export type AdjustmentOutcome =
  | { kind: 'ok'; result: StockAdjustmentResult }
  | { kind: 'forbidden' }
  | { kind: 'outlet-not-found' }
  | { kind: 'outlet-inactive' }
  | { kind: 'assignment-not-found' }
  | { kind: 'stale'; currentStockQuantity: number }
  | { kind: 'insufficient'; currentStockQuantity: number }
  | { kind: 'overflow'; currentStockQuantity: number };
