import {
  AuthorizationError,
  BadRequestError,
  ConflictError,
  NotFoundError,
} from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type { OutletMenuItemRepository } from '@/modules/outlet-menu-items/outlet-menu-item.repository.js';
import type {
  AssignmentWriteResult,
  OutletMenuItem,
  OutletMenuListQuery,
  OutletMenuScope,
} from '@/modules/outlet-menu-items/outlet-menu-item.types.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';

export type OutletMenuItemStore = Pick<
  OutletMenuItemRepository,
  'list' | 'find' | 'assign' | 'setOverridePrice' | 'setActive'
>;

const scopeFor = (user: AuthenticatedUser): OutletMenuScope =>
  user.role === Role.HQ_ADMIN ? { kind: 'all' } : { kind: 'member', userId: user.id };

const alreadyAssigned = (isActive: boolean): ConflictError =>
  new ConflictError(
    isActive
      ? 'This menu item is already assigned to the outlet'
      : 'This menu item has an inactive assignment in the outlet; reactivate it instead',
    [
      {
        field: 'body.menuItemId',
        message: isActive
          ? 'Already assigned to this outlet'
          : 'Previously assigned and currently inactive. Reactivate the existing assignment.',
      },
    ],
  );

function assertWritten(result: AssignmentWriteResult): void {
  switch (result.kind) {
    case 'ok':
      return;
    case 'forbidden':
      throw new AuthorizationError();
    case 'outlet-not-found':
      throw new NotFoundError('Outlet not found');
    case 'assignment-not-found':
      throw new NotFoundError('Menu item is not assigned to this outlet');
    case 'outlet-inactive':
      throw new ConflictError('The outlet is inactive');
    case 'already-assigned':
      throw alreadyAssigned(result.isActive);
    case 'menu-item-not-found':
      throw new BadRequestError('Validation failed', 'VALIDATION_ERROR', [
        { field: 'body.menuItemId', message: 'Menu item not found' },
      ]);
    case 'menu-item-inactive':
      throw new ConflictError('The master menu item is inactive', [
        { field: 'body.menuItemId', message: 'The master menu item is inactive' },
      ]);
  }
}

export class OutletMenuItemService {
  public constructor(private readonly repository: OutletMenuItemStore) {}

  public async list(
    user: AuthenticatedUser,
    outletId: string,
    query: OutletMenuListQuery,
  ): Promise<Paginated<OutletMenuItem>> {
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
  ): Promise<OutletMenuItem> {
    const item = await this.repository.find(outletId, menuItemId, scopeFor(user));
    if (!item) throw new NotFoundError('Menu item is not assigned to this outlet');
    return item;
  }

  public async assign(
    admin: AuthenticatedUser,
    outletId: string,
    menuItemId: string,
    overridePrice: string | null,
  ): Promise<OutletMenuItem> {
    try {
      assertWritten(await this.repository.assign(admin.id, outletId, menuItemId, overridePrice));
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw alreadyAssigned(true);
      }
      throw error;
    }
    return this.get(admin, outletId, menuItemId);
  }

  public async setOverridePrice(
    admin: AuthenticatedUser,
    outletId: string,
    menuItemId: string,
    overridePrice: string | null,
  ): Promise<OutletMenuItem> {
    assertWritten(
      await this.repository.setOverridePrice(admin.id, outletId, menuItemId, overridePrice),
    );
    return this.get(admin, outletId, menuItemId);
  }

  public async setStatus(
    admin: AuthenticatedUser,
    outletId: string,
    menuItemId: string,
    isActive: boolean,
  ): Promise<OutletMenuItem> {
    assertWritten(await this.repository.setActive(admin.id, outletId, menuItemId, isActive));
    return this.get(admin, outletId, menuItemId);
  }
}
