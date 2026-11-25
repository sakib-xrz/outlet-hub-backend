import { serializeMoney } from '@/common/money.js';
import type { DatabaseClient, DatabaseExecutor } from '@/database/client.js';
import {
  lockMenuItemShared,
  lockOutletMenuItem,
  lockOutletShared,
  lockUser,
} from '@/database/locks.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type {
  AssignmentWriteResult,
  OutletMenuItem,
  OutletMenuListQuery,
  OutletMenuScope,
} from '@/modules/outlet-menu-items/outlet-menu-item.types.js';

const assignmentSelect = {
  outletId: true,
  menuItemId: true,
  overridePrice: true,
  stockQuantity: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  outlet: { select: { isActive: true } },
  menuItem: {
    select: { sku: true, name: true, description: true, basePrice: true, isActive: true },
  },
} satisfies Prisma.OutletMenuItemSelect;

type AssignmentRow = Prisma.OutletMenuItemGetPayload<{ select: typeof assignmentSelect }>;

export function toOutletMenuItem(row: AssignmentRow): OutletMenuItem {
  const hasOverride = row.overridePrice !== null;
  const effective = row.overridePrice ?? row.menuItem.basePrice;
  const isEnabled = row.outlet.isActive && row.menuItem.isActive && row.isActive;
  return {
    outletId: row.outletId,
    menuItemId: row.menuItemId,
    sku: row.menuItem.sku,
    name: row.menuItem.name,
    description: row.menuItem.description,
    basePrice: serializeMoney(row.menuItem.basePrice),
    overridePrice: row.overridePrice !== null ? serializeMoney(row.overridePrice) : null,
    effectivePrice: serializeMoney(effective),
    priceSource: hasOverride ? 'OVERRIDE' : 'BASE',
    stockQuantity: row.stockQuantity,
    isActive: row.isActive,
    outletIsActive: row.outlet.isActive,
    menuItemIsActive: row.menuItem.isActive,
    isEnabled,
    isSellable: isEnabled && row.stockQuantity > 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function scopeWhere(outletId: string, scope: OutletMenuScope): Prisma.OutletMenuItemWhereInput {
  if (scope.kind === 'all') return { outletId };
  return {
    outletId,
    isActive: true,
    menuItem: { isActive: true },
    outlet: { isActive: true, memberships: { some: { userId: scope.userId } } },
  };
}

function listWhere(
  outletId: string,
  query: OutletMenuListQuery,
  scope: OutletMenuScope,
): Prisma.OutletMenuItemWhereInput {
  const conditions: Prisma.OutletMenuItemWhereInput[] = [scopeWhere(outletId, scope)];
  if (query.status !== 'all') conditions.push({ isActive: query.status === 'active' });
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

function orderBy(query: OutletMenuListQuery): Prisma.OutletMenuItemOrderByWithRelationInput[] {
  const primary: Prisma.OutletMenuItemOrderByWithRelationInput =
    query.sortBy === 'sku' || query.sortBy === 'name'
      ? { menuItem: { [query.sortBy]: query.sortOrder } }
      : { [query.sortBy]: query.sortOrder };
  return [primary, { menuItemId: 'asc' }];
}

async function lockActingAdmin(client: DatabaseExecutor, adminId: string): Promise<boolean> {
  const admin = await lockUser(client, adminId, 'share');
  return admin?.isActive === true && admin.role === Role.HQ_ADMIN;
}

export class OutletMenuItemRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(
    outletId: string,
    query: OutletMenuListQuery,
    scope: OutletMenuScope,
  ): Promise<{ items: OutletMenuItem[]; total: number }> {
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
    return { items: rows.map(toOutletMenuItem), total };
  }

  public async find(
    outletId: string,
    menuItemId: string,
    scope: OutletMenuScope,
  ): Promise<OutletMenuItem | null> {
    const row = await this.database.outletMenuItem.findFirst({
      where: { ...scopeWhere(outletId, scope), menuItemId },
      select: assignmentSelect,
    });
    return row ? toOutletMenuItem(row) : null;
  }

  public assign(
    adminId: string,
    outletId: string,
    menuItemId: string,
    overridePrice: string | null,
  ): Promise<AssignmentWriteResult> {
    return this.database.$transaction(async (transaction) => {
      if (!(await lockActingAdmin(transaction, adminId))) return { kind: 'forbidden' };
      const outlet = await lockOutletShared(transaction, outletId);
      if (!outlet) return { kind: 'outlet-not-found' };
      if (!outlet.isActive) return { kind: 'outlet-inactive' };
      const existing = await lockOutletMenuItem(transaction, outletId, menuItemId);
      if (existing) return { kind: 'already-assigned', isActive: existing.isActive };
      const menuItem = await lockMenuItemShared(transaction, menuItemId);
      if (!menuItem) return { kind: 'menu-item-not-found' };
      if (!menuItem.isActive) return { kind: 'menu-item-inactive' };

      await transaction.outletMenuItem.create({
        data: { outletId, menuItemId, overridePrice, stockQuantity: 0, isActive: true },
      });
      return { kind: 'ok' };
    });
  }

  public setOverridePrice(
    adminId: string,
    outletId: string,
    menuItemId: string,
    overridePrice: string | null,
  ): Promise<AssignmentWriteResult> {
    return this.database.$transaction(async (transaction) => {
      if (!(await lockActingAdmin(transaction, adminId))) return { kind: 'forbidden' };
      if (!(await lockOutletShared(transaction, outletId))) return { kind: 'outlet-not-found' };
      if (!(await lockOutletMenuItem(transaction, outletId, menuItemId))) {
        return { kind: 'assignment-not-found' };
      }
      await transaction.outletMenuItem.update({
        where: { outletId_menuItemId: { outletId, menuItemId } },
        data: { overridePrice },
      });
      return { kind: 'ok' };
    });
  }

  public setActive(
    adminId: string,
    outletId: string,
    menuItemId: string,
    isActive: boolean,
  ): Promise<AssignmentWriteResult> {
    return this.database.$transaction(async (transaction) => {
      if (!(await lockActingAdmin(transaction, adminId))) return { kind: 'forbidden' };
      const outlet = await lockOutletShared(transaction, outletId);
      if (!outlet) return { kind: 'outlet-not-found' };
      const assignment = await lockOutletMenuItem(transaction, outletId, menuItemId);
      if (!assignment) return { kind: 'assignment-not-found' };
      if (assignment.isActive === isActive) return { kind: 'ok' };

      if (isActive) {
        if (!outlet.isActive) return { kind: 'outlet-inactive' };
        const menuItem = await lockMenuItemShared(transaction, menuItemId);
        if (!menuItem?.isActive) return { kind: 'menu-item-inactive' };
      }
      await transaction.outletMenuItem.update({
        where: { outletId_menuItemId: { outletId, menuItemId } },
        data: { isActive },
      });
      return { kind: 'ok' };
    });
  }
}
