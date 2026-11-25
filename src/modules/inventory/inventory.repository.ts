import type { DatabaseClient } from '@/database/client.js';
import { lockActiveHqAdmin, lockOutletMenuItem, lockOutletShared } from '@/database/locks.js';
import type { Prisma } from '@/generated/prisma/client.js';
import {
  type AssignmentRow,
  assignmentSelect,
  scopeWhere,
  toOutletMenuItem,
} from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';
import type { OutletMenuScope } from '@/modules/outlet-menu-items/outlet-menu-item.types.js';
import type {
  AdjustmentOutcome,
  InventoryItem,
  InventoryListQuery,
  StockAdjustment,
  StockStatus,
} from '@/modules/inventory/inventory.types.js';
import {
  LOW_STOCK_THRESHOLD,
  MAX_STOCK_QUANTITY,
} from '@/modules/inventory/inventory.validation.js';

export function classifyStock(quantity: number): StockStatus {
  if (quantity <= 0) return 'OUT_OF_STOCK';
  return quantity <= LOW_STOCK_THRESHOLD ? 'LOW' : 'IN_STOCK';
}

export function toInventoryItem(row: AssignmentRow): InventoryItem {
  const item = toOutletMenuItem(row);
  return {
    outletId: item.outletId,
    menuItemId: item.menuItemId,
    sku: item.sku,
    name: item.name,
    stockQuantity: item.stockQuantity,
    stockStatus: classifyStock(item.stockQuantity),
    isActive: item.isActive,
    outletIsActive: item.outletIsActive,
    menuItemIsActive: item.menuItemIsActive,
    isEnabled: item.isEnabled,
    isSellable: item.isSellable,
    updatedAt: item.updatedAt,
  };
}

const STOCK_FILTERS: Record<Exclude<InventoryListQuery['stockStatus'], 'all'>, Prisma.IntFilter> = {
  out_of_stock: { equals: 0 },
  low: { gte: 1, lte: LOW_STOCK_THRESHOLD },
  in_stock: { gt: LOW_STOCK_THRESHOLD },
};

function listWhere(
  outletId: string,
  query: InventoryListQuery,
  scope: OutletMenuScope,
): Prisma.OutletMenuItemWhereInput {
  const conditions: Prisma.OutletMenuItemWhereInput[] = [scopeWhere(outletId, scope)];
  if (query.status !== 'all') conditions.push({ isActive: query.status === 'active' });
  if (query.stockStatus !== 'all') {
    conditions.push({ stockQuantity: STOCK_FILTERS[query.stockStatus] });
  }
  if (query.search) {
    conditions.push({
      menuItem: {
        OR: [
          { sku: { contains: query.search, mode: 'insensitive' } },
          { name: { contains: query.search, mode: 'insensitive' } },
        ],
      },
    });
  }
  return { AND: conditions };
}

function orderBy(query: InventoryListQuery): Prisma.OutletMenuItemOrderByWithRelationInput[] {
  const primary: Prisma.OutletMenuItemOrderByWithRelationInput =
    query.sortBy === 'sku' || query.sortBy === 'name'
      ? { menuItem: { [query.sortBy]: query.sortOrder } }
      : { [query.sortBy]: query.sortOrder };
  return [primary, { menuItemId: 'asc' }];
}

export function nextStockQuantity(
  current: number,
  adjustment: StockAdjustment,
): { kind: 'ok'; quantity: number } | { kind: 'stale' | 'insufficient' | 'overflow' } {
  if (adjustment.operation === 'SET') {
    if (adjustment.expectedStockQuantity !== current) return { kind: 'stale' };
    return { kind: 'ok', quantity: adjustment.quantity };
  }
  const next =
    adjustment.operation === 'INCREASE'
      ? current + adjustment.quantity
      : current - adjustment.quantity;
  if (next < 0) return { kind: 'insufficient' };
  if (next > MAX_STOCK_QUANTITY) return { kind: 'overflow' };
  return { kind: 'ok', quantity: next };
}

export class InventoryRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(
    outletId: string,
    query: InventoryListQuery,
    scope: OutletMenuScope,
  ): Promise<{ items: InventoryItem[]; total: number }> {
    const where = listWhere(outletId, query, scope);
    const [rows, total] = await this.database.$transaction([
      this.database.outletMenuItem.findMany({
        where,
        select: assignmentSelect,
        orderBy: orderBy(query),
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.database.outletMenuItem.count({ where }),
    ]);
    return { items: rows.map(toInventoryItem), total };
  }

  public async find(
    outletId: string,
    menuItemId: string,
    scope: OutletMenuScope,
  ): Promise<InventoryItem | null> {
    const row = await this.database.outletMenuItem.findFirst({
      where: { ...scopeWhere(outletId, scope), menuItemId },
      select: assignmentSelect,
    });
    return row ? toInventoryItem(row) : null;
  }

  public adjust(
    adminId: string,
    outletId: string,
    menuItemId: string,
    adjustment: StockAdjustment,
  ): Promise<AdjustmentOutcome> {
    return this.database.$transaction(async (transaction) => {
      if (!(await lockActiveHqAdmin(transaction, adminId))) return { kind: 'forbidden' };
      const outlet = await lockOutletShared(transaction, outletId);
      if (!outlet) return { kind: 'outlet-not-found' };
      if (!outlet.isActive) return { kind: 'outlet-inactive' };
      const assignment = await lockOutletMenuItem(transaction, outletId, menuItemId);
      if (!assignment) return { kind: 'assignment-not-found' };

      const previous = assignment.stockQuantity;
      const next = nextStockQuantity(previous, adjustment);
      if (next.kind !== 'ok') return { kind: next.kind, currentStockQuantity: previous };

      const where = { outletId_menuItemId: { outletId, menuItemId } };
      const changed = next.quantity !== previous;
      const row = changed
        ? await transaction.outletMenuItem.update({
            where,
            data: { stockQuantity: next.quantity },
            select: assignmentSelect,
          })
        : await transaction.outletMenuItem.findUniqueOrThrow({ where, select: assignmentSelect });

      return {
        kind: 'ok',
        result: {
          inventoryItem: toInventoryItem(row),
          operation: adjustment.operation,
          previousStockQuantity: previous,
          newStockQuantity: next.quantity,
          changed,
        },
      };
    });
  }
}
