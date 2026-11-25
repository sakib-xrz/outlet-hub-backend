import { ConflictError, NotFoundError } from '@/common/errors/app-error.js';
import { Prisma } from '@/generated/prisma/client.js';
import type { MenuItemRepository } from '@/modules/menu-items/menu-item.repository.js';
import type {
  CreateMenuItemInput,
  MenuItem,
  MenuItemListQuery,
  UpdateMenuItemInput,
} from '@/modules/menu-items/menu-item.types.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';

export type MenuItemStore = Pick<
  MenuItemRepository,
  'list' | 'findById' | 'create' | 'update' | 'setActive'
>;

const isPrismaError = (error: unknown, code: string): boolean =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

const notFound = (): NotFoundError => new NotFoundError('Menu item not found');

export class MenuItemService {
  public constructor(private readonly repository: MenuItemStore) {}

  public async list(query: MenuItemListQuery): Promise<Paginated<MenuItem>> {
    const { items, total } = await this.repository.list(query);
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

  public async getById(id: string): Promise<MenuItem> {
    const item = await this.repository.findById(id);
    if (!item) throw notFound();
    return item;
  }

  public async create(input: CreateMenuItemInput): Promise<MenuItem> {
    try {
      return await this.repository.create(input);
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new ConflictError('A menu item with this SKU already exists', [
          { field: 'body.sku', message: 'This SKU is already in use' },
        ]);
      }
      throw error;
    }
  }

  public async update(id: string, input: UpdateMenuItemInput): Promise<MenuItem> {
    try {
      return await this.repository.update(id, input);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) throw notFound();
      throw error;
    }
  }

  public async setStatus(id: string, isActive: boolean): Promise<MenuItem> {
    const item = await this.repository.setActive(id, isActive);
    if (!item) throw notFound();
    return item;
  }
}
