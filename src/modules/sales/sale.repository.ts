import { serializeMoney } from '@/common/money.js';
import type { DatabaseClient, DatabaseExecutor } from '@/database/client.js';
import {
  incrementReceiptCounter,
  lockMenuItemsShared,
  lockOutletMenuItems,
  lockOutletShared,
  lockReceiptCounter,
  lockUser,
} from '@/database/locks.js';
import type { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { MAX_INT, priceLines, receiptCode } from '@/modules/sales/sale-calculation.js';
import type {
  CreateSaleCommand,
  CreateSaleOutcome,
  Sale,
  SaleListQuery,
  SaleScope,
  SaleSummary,
} from '@/modules/sales/sale.types.js';

const saleSelect = {
  id: true,
  outletId: true,
  receiptNumber: true,
  requestId: true,
  createdById: true,
  totalAmount: true,
  createdAt: true,
  outlet: { select: { code: true, name: true } },
  items: {
    select: { menuItemId: true, itemName: true, quantity: true, unitPrice: true, lineTotal: true },
    orderBy: { menuItemId: 'asc' },
  },
} satisfies Prisma.SaleSelect;

type SaleRow = Prisma.SaleGetPayload<{ select: typeof saleSelect }>;

export function toSale(row: SaleRow): Sale {
  return {
    id: row.id,
    outletId: row.outletId,
    outletCode: row.outlet.code,
    outletName: row.outlet.name,
    receiptNumber: row.receiptNumber,
    receiptCode: receiptCode(row.outlet.code, row.receiptNumber),
    requestId: row.requestId,
    createdById: row.createdById,
    totalAmount: serializeMoney(row.totalAmount),
    createdAt: row.createdAt,
    items: row.items.map((item) => ({
      menuItemId: item.menuItemId,
      itemName: item.itemName,
      quantity: item.quantity,
      unitPrice: serializeMoney(item.unitPrice),
      lineTotal: serializeMoney(item.lineTotal),
    })),
  };
}

function scopeWhere(outletId: string, scope: SaleScope): Prisma.SaleWhereInput {
  return scope.kind === 'all'
    ? { outletId }
    : { outletId, outlet: { isActive: true, memberships: { some: { userId: scope.userId } } } };
}

async function authorizeCashier(
  client: DatabaseExecutor,
  userId: string,
  outletId: string,
): Promise<boolean> {
  const user = await lockUser(client, userId, 'share');
  if (!user?.isActive || user.role !== Role.OUTLET_STAFF) return false;
  const membership = await client.outletMembership.findUnique({
    where: { userId_outletId: { userId, outletId } },
    select: { outletId: true },
  });
  return membership !== null;
}

export class SaleRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public createSale(command: CreateSaleCommand): Promise<CreateSaleOutcome> {
    const { userId, outletId, requestId, requestHash, items } = command;
    const ids = items.map((item) => item.menuItemId);

    return this.database.$transaction(
      async (transaction): Promise<CreateSaleOutcome> => {
        if (!(await authorizeCashier(transaction, userId, outletId))) return { kind: 'forbidden' };

        const outlet = await lockOutletShared(transaction, outletId);
        if (!outlet) return { kind: 'outlet-not-found' };
        if (!outlet.isActive) return { kind: 'outlet-inactive' };

        const counter = await lockReceiptCounter(transaction, outletId);
        if (!counter) return { kind: 'counter-missing' };

        const existing = await transaction.sale.findUnique({
          where: { outletId_requestId: { outletId, requestId } },
          select: { id: true, createdById: true, requestHash: true },
        });
        if (existing) {
          return existing.createdById === userId && existing.requestHash === requestHash
            ? { kind: 'replay', saleId: existing.id }
            : { kind: 'idempotency-conflict' };
        }

        const assignments = new Map(
          (await lockOutletMenuItems(transaction, outletId, ids)).map((row) => [
            row.menuItemId,
            row,
          ]),
        );
        const masters = new Map(
          (await lockMenuItemsShared(transaction, ids)).map((row) => [row.id, row]),
        );

        const unavailable: { menuItemId: string; reason: string }[] = [];
        const insufficient: {
          menuItemId: string;
          requestedQuantity: number;
          availableQuantity: number;
        }[] = [];
        const changed: {
          menuItemId: string;
          expectedUnitPrice: string;
          currentUnitPrice: string;
        }[] = [];
        const lines: {
          menuItemId: string;
          itemName: string;
          quantity: number;
          unitPrice: string;
        }[] = [];

        for (const item of items) {
          const assignment = assignments.get(item.menuItemId);
          const master = masters.get(item.menuItemId);
          if (!assignment || !master) {
            unavailable.push({
              menuItemId: item.menuItemId,
              reason: 'Not assigned to this outlet',
            });
            continue;
          }
          if (!assignment.isActive || !master.isActive) {
            unavailable.push({ menuItemId: item.menuItemId, reason: 'Not available for sale' });
            continue;
          }
          if (assignment.stockQuantity < item.quantity) {
            insufficient.push({
              menuItemId: item.menuItemId,
              requestedQuantity: item.quantity,
              availableQuantity: assignment.stockQuantity,
            });
          }
          const unitPrice = assignment.overridePrice ?? master.basePrice;
          const current = priceLines([
            { menuItemId: item.menuItemId, itemName: master.name, quantity: 1, unitPrice },
          ]);
          const currentUnitPrice = current.kind === 'ok' ? (current.lines[0]?.unitPrice ?? '') : '';
          if (currentUnitPrice !== item.expectedUnitPrice) {
            changed.push({
              menuItemId: item.menuItemId,
              expectedUnitPrice: item.expectedUnitPrice,
              currentUnitPrice,
            });
          }
          lines.push({
            menuItemId: item.menuItemId,
            itemName: master.name,
            quantity: item.quantity,
            unitPrice,
          });
        }

        if (unavailable.length) return { kind: 'unavailable', items: unavailable };
        if (changed.length) return { kind: 'price-changed', items: changed };
        if (insufficient.length) return { kind: 'insufficient', items: insufficient };

        const pricing = priceLines(lines);
        if (pricing.kind === 'limit-exceeded') return { kind: 'total-limit' };
        if (counter.lastNumber >= MAX_INT) return { kind: 'receipt-limit' };

        for (const item of items) {
          const deducted = await transaction.outletMenuItem.updateMany({
            where: { outletId, menuItemId: item.menuItemId, stockQuantity: { gte: item.quantity } },
            data: { stockQuantity: { decrement: item.quantity } },
          });
          if (deducted.count !== 1) {
            throw new Error(`Guarded stock deduction failed for menu item ${item.menuItemId}`);
          }
        }

        const receiptNumber = await incrementReceiptCounter(transaction, outletId);

        const sale = await transaction.sale.create({
          data: {
            outletId,
            createdById: userId,
            receiptNumber,
            requestId,
            requestHash,
            totalAmount: pricing.totalAmount,
          },
          select: { id: true },
        });
        await transaction.saleItem.createMany({
          data: pricing.lines.map((line) => ({
            saleId: sale.id,
            outletId,
            menuItemId: line.menuItemId,
            itemName: line.itemName,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            lineTotal: line.lineTotal,
          })),
        });
        return { kind: 'created', saleId: sale.id };
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  public async findById(outletId: string, saleId: string, scope: SaleScope): Promise<Sale | null> {
    const row = await this.database.sale.findFirst({
      where: { ...scopeWhere(outletId, scope), id: saleId },
      select: saleSelect,
    });
    return row ? toSale(row) : null;
  }

  public async findByRequest(
    outletId: string,
    requestId: string,
    userId: string,
  ): Promise<Sale | null> {
    const row = await this.database.sale.findFirst({
      where: {
        ...scopeWhere(outletId, { kind: 'member', userId }),
        requestId,
        createdById: userId,
      },
      select: saleSelect,
    });
    return row ? toSale(row) : null;
  }

  public async list(
    outletId: string,
    query: SaleListQuery,
    scope: SaleScope,
  ): Promise<{ items: SaleSummary[]; total: number }> {
    const where: Prisma.SaleWhereInput = {
      ...scopeWhere(outletId, scope),
      ...(query.search !== undefined && { receiptNumber: query.search }),
      ...((query.from ?? query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };
    const [rows, total] = await this.database.$transaction([
      this.database.sale.findMany({
        where,
        select: {
          id: true,
          receiptNumber: true,
          totalAmount: true,
          createdById: true,
          createdAt: true,
          outlet: { select: { code: true } },
          _count: { select: { items: true } },
        },
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.database.sale.count({ where }),
    ]);
    const units = rows.length
      ? await this.database.saleItem.groupBy({
          by: ['saleId'],
          where: { outletId, saleId: { in: rows.map((row) => row.id) } },
          _sum: { quantity: true },
        })
      : [];
    const unitsBySale = new Map(units.map((entry) => [entry.saleId, entry._sum.quantity ?? 0]));
    return {
      items: rows.map((row) => ({
        id: row.id,
        receiptNumber: row.receiptNumber,
        receiptCode: receiptCode(row.outlet.code, row.receiptNumber),
        totalAmount: serializeMoney(row.totalAmount),
        lineCount: row._count.items,
        unitCount: unitsBySale.get(row.id) ?? 0,
        createdById: row.createdById,
        createdAt: row.createdAt,
      })),
      total,
    };
  }
}
