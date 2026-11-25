import { AppError, AuthorizationError, NotFoundError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type { InventoryRepository } from '@/modules/inventory/inventory.repository.js';
import type {
  AdjustmentOutcome,
  InventoryItem,
  InventoryListQuery,
  StockAdjustment,
  StockAdjustmentResult,
} from '@/modules/inventory/inventory.types.js';
import type { OutletMenuScope } from '@/modules/outlet-menu-items/outlet-menu-item.types.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';

export type InventoryStore = Pick<InventoryRepository, 'list' | 'find' | 'adjust'>;

const MAX_ATTEMPTS = 2;

const scopeFor = (user: AuthenticatedUser): OutletMenuScope =>
  user.role === Role.HQ_ADMIN ? { kind: 'all' } : { kind: 'member', userId: user.id };

const conflict = (code: string, message: string): AppError => new AppError(409, code, message);

function unwrap(outcome: AdjustmentOutcome): StockAdjustmentResult {
  switch (outcome.kind) {
    case 'ok':
      return outcome.result;
    case 'forbidden':
      throw new AuthorizationError();
    case 'outlet-not-found':
      throw new NotFoundError('Outlet not found');
    case 'assignment-not-found':
      throw new NotFoundError('Menu item is not assigned to this outlet');
    case 'outlet-inactive':
      throw conflict('OUTLET_INACTIVE', 'Stock cannot be adjusted while the outlet is inactive');
    case 'stale':
      throw conflict(
        'STOCK_CHANGED',
        `Stock changed since the correction was started; it is now ${outcome.currentStockQuantity}`,
      );
    case 'insufficient':
      throw conflict(
        'INSUFFICIENT_STOCK',
        `Not enough stock; only ${outcome.currentStockQuantity} available`,
      );
    case 'overflow':
      throw conflict(
        'STOCK_LIMIT_EXCEEDED',
        'The resulting stock would exceed the maximum allowed',
      );
  }
}

function isTransactionConflict(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
}

export class InventoryService {
  public constructor(private readonly repository: InventoryStore) {}

  public async list(
    user: AuthenticatedUser,
    outletId: string,
    query: InventoryListQuery,
  ): Promise<Paginated<InventoryItem>> {
    const { items, total } = await this.repository.list(outletId, query, scopeFor(user));
    return {
      items,
      pagination: {
        page: query.page,
        limit: query.limit,
        total,
        totalPages: Math.ceil(total / query.limit),
      },
    };
  }

  public async get(
    user: AuthenticatedUser,
    outletId: string,
    menuItemId: string,
  ): Promise<InventoryItem> {
    const item = await this.repository.find(outletId, menuItemId, scopeFor(user));
    if (!item) throw new NotFoundError('Menu item is not assigned to this outlet');
    return item;
  }

  public async adjust(
    admin: AuthenticatedUser,
    outletId: string,
    menuItemId: string,
    adjustment: StockAdjustment,
  ): Promise<StockAdjustmentResult> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return unwrap(await this.repository.adjust(admin.id, outletId, menuItemId, adjustment));
      } catch (error) {
        if (!isTransactionConflict(error)) throw error;
        if (attempt >= MAX_ATTEMPTS) {
          throw conflict(
            'CONCURRENT_UPDATE',
            'Stock is being changed by another request; try again',
          );
        }
      }
    }
  }
}
