import { serializeMoney } from '@/common/money.js';
import type { DatabaseClient } from '@/database/client.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type {
  CreateMenuItemInput,
  MenuItem,
  MenuItemListQuery,
  UpdateMenuItemInput,
} from '@/modules/menu-items/menu-item.types.js';

const menuItemSelect = {
  id: true,
  sku: true,
  name: true,
  description: true,
  basePrice: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.MenuItemSelect;

type MenuItemRow = Prisma.MenuItemGetPayload<{ select: typeof menuItemSelect }>;

const toMenuItem = (row: MenuItemRow): MenuItem => ({
  ...row,
  basePrice: serializeMoney(row.basePrice),
});

function listWhere(query: MenuItemListQuery): Prisma.MenuItemWhereInput {
  return {
    ...(query.status !== 'all' && { isActive: query.status === 'active' }),
    ...(query.search && {
      OR: [
        { sku: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ],
    }),
  };
}

export class MenuItemRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(query: MenuItemListQuery): Promise<{ items: MenuItem[]; total: number }> {
    const where = listWhere(query);
    const [rows, total] = await this.database.$transaction([
      this.database.menuItem.findMany({
        where,
        select: menuItemSelect,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.database.menuItem.count({ where }),
    ]);
    return { items: rows.map(toMenuItem), total };
  }

  public async findById(id: string): Promise<MenuItem | null> {
    const row = await this.database.menuItem.findUnique({ where: { id }, select: menuItemSelect });
    return row ? toMenuItem(row) : null;
  }

  public async create(input: CreateMenuItemInput): Promise<MenuItem> {
    const row = await this.database.menuItem.create({
      data: { ...input, isActive: true },
      select: menuItemSelect,
    });
    return toMenuItem(row);
  }

  public async update(id: string, input: UpdateMenuItemInput): Promise<MenuItem> {
    const data: Prisma.MenuItemUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.basePrice !== undefined && { basePrice: input.basePrice }),
    };
    const row = await this.database.menuItem.update({
      where: { id },
      data,
      select: menuItemSelect,
    });
    return toMenuItem(row);
  }

  public async setActive(id: string, isActive: boolean): Promise<MenuItem | null> {
    await this.database.menuItem.updateMany({
      where: { id, isActive: !isActive },
      data: { isActive },
    });
    return this.findById(id);
  }
}
