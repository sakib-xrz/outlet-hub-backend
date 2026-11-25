import type { z } from 'zod';
import type {
  createMenuItemSchema,
  menuItemListQuerySchema,
  updateMenuItemSchema,
  updateMenuItemStatusSchema,
} from '@/modules/menu-items/menu-item.validation.js';

export type MenuItem = {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  basePrice: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type MenuItemListQuery = z.infer<typeof menuItemListQuerySchema>;
export type CreateMenuItemInput = z.infer<typeof createMenuItemSchema>;
export type UpdateMenuItemInput = z.infer<typeof updateMenuItemSchema>;
export type UpdateMenuItemStatusInput = z.infer<typeof updateMenuItemStatusSchema>;
