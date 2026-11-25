import {
  AppError,
  AuthorizationError,
  BadRequestError,
  NotFoundError,
} from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';
import { hashSaleRequest, normalizeSaleItems } from '@/modules/sales/sale-calculation.js';
import type { SaleRepository } from '@/modules/sales/sale.repository.js';
import type {
  CreateSaleInput,
  CreateSaleOutcome,
  Sale,
  SaleListQuery,
  SaleScope,
  SaleSummary,
} from '@/modules/sales/sale.types.js';

export type SaleStore = Pick<SaleRepository, 'createSale' | 'findById' | 'findByRequest' | 'list'>;

const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 25;

const conflict = (
  code: string,
  message: string,
  errors?: { field?: string; message: string; meta?: Record<string, string | number> }[],
): AppError => new AppError(409, code, message, errors);

const scopeFor = (user: AuthenticatedUser): SaleScope =>
  user.role === Role.HQ_ADMIN ? { kind: 'all' } : { kind: 'member', userId: user.id };

function isRetryable(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    (error.code === 'P2034' || error.code === 'P2002')
  );
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function toSaleId(outcome: CreateSaleOutcome): { saleId: string; replayed: boolean } {
  switch (outcome.kind) {
    case 'created':
      return { saleId: outcome.saleId, replayed: false };
    case 'replay':
      return { saleId: outcome.saleId, replayed: true };
    case 'forbidden':
      throw new AuthorizationError('You cannot sell in this outlet');
    case 'outlet-not-found':
      throw new NotFoundError('Outlet not found');
    case 'outlet-inactive':
      throw conflict('OUTLET_INACTIVE', 'Sales cannot be created while the outlet is inactive');
    case 'counter-missing':
      throw new AppError(
        500,
        'RECEIPT_COUNTER_MISSING',
        'The outlet receipt counter is missing; contact an administrator',
        undefined,
        false,
      );
    case 'idempotency-conflict':
      throw conflict(
        'IDEMPOTENCY_CONFLICT',
        'This request id was already used for a different sale. Start a new sale.',
      );
    case 'unavailable':
      throw conflict(
        'ITEM_UNAVAILABLE',
        'Some items are not available for sale in this outlet',
        outcome.items.map(({ menuItemId, reason }) => ({
          field: `items.${menuItemId}`,
          message: reason,
          meta: { menuItemId },
        })),
      );
    case 'price-changed':
      throw conflict(
        'PRICE_CHANGED',
        'Some prices changed. Review the cart and confirm again.',
        outcome.items.map(({ menuItemId, expectedUnitPrice, currentUnitPrice }) => ({
          field: `items.${menuItemId}`,
          message: `Price changed from ${expectedUnitPrice} to ${currentUnitPrice}`,
          meta: { menuItemId, expectedUnitPrice, currentUnitPrice },
        })),
      );
    case 'insufficient':
      throw conflict(
        'INSUFFICIENT_STOCK',
        'Not enough stock for some items',
        outcome.items.map(({ menuItemId, requestedQuantity, availableQuantity }) => ({
          field: `items.${menuItemId}`,
          message: `Only ${availableQuantity} available`,
          meta: { menuItemId, requestedQuantity, availableQuantity },
        })),
      );
    case 'total-limit':
      throw conflict('SALE_TOTAL_LIMIT_EXCEEDED', 'The sale total exceeds the maximum allowed');
    case 'receipt-limit':
      throw conflict('RECEIPT_LIMIT_EXCEEDED', 'This outlet has reached its receipt number limit');
  }
}

export class SaleService {
  public constructor(private readonly repository: SaleStore) {}

  public async create(
    user: AuthenticatedUser,
    outletId: string,
    input: CreateSaleInput,
  ): Promise<{ sale: Sale; replayed: boolean }> {
    const normalized = normalizeSaleItems(input.items);
    if (normalized.kind === 'invalid') {
      throw new BadRequestError('Validation failed', 'VALIDATION_ERROR', [
        {
          field: `body.items.${normalized.menuItemId}`,
          message: normalized.message,
          meta: { menuItemId: normalized.menuItemId },
        },
      ]);
    }
    const command = {
      userId: user.id,
      outletId,
      requestId: input.requestId,
      requestHash: hashSaleRequest(normalized.items),
      items: normalized.items,
    };

    for (let attempt = 1; ; attempt += 1) {
      try {
        const { saleId, replayed } = toSaleId(await this.repository.createSale(command));
        const sale = await this.repository.findById(outletId, saleId, { kind: 'all' });
        if (!sale) throw new Error('Committed sale could not be read back');
        return { sale, replayed };
      } catch (error) {
        if (!isRetryable(error)) throw error;
        if (attempt >= MAX_ATTEMPTS) {
          throw conflict('CONCURRENT_UPDATE', 'The outlet is busy. Retry the same sale.');
        }
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }

  public async list(
    user: AuthenticatedUser,
    outletId: string,
    query: SaleListQuery,
  ): Promise<Paginated<SaleSummary>> {
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

  public async get(user: AuthenticatedUser, outletId: string, saleId: string): Promise<Sale> {
    const sale = await this.repository.findById(outletId, saleId, scopeFor(user));
    if (!sale) throw new NotFoundError('Sale not found');
    return sale;
  }

  public async getByRequest(
    user: AuthenticatedUser,
    outletId: string,
    requestId: string,
  ): Promise<Sale> {
    const sale = await this.repository.findByRequest(outletId, requestId, user.id);
    if (!sale) throw new NotFoundError('No completed sale found for this request');
    return sale;
  }
}
