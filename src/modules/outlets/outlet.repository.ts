import type { DatabaseClient } from '@/database/client.js';
import type { Prisma } from '@/generated/prisma/client.js';
import type {
  CreateOutletInput,
  Outlet,
  OutletListQuery,
  OutletListScope,
  UpdateOutletInput,
} from '@/modules/outlets/outlet.types.js';

const outletSelect = {
  id: true,
  code: true,
  name: true,
  address: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.OutletSelect;

function listWhere(query: OutletListQuery, scope: OutletListScope): Prisma.OutletWhereInput {
  const conditions: Prisma.OutletWhereInput[] = [];
  if (scope.kind === 'member') {
    conditions.push({ isActive: true, memberships: { some: { userId: scope.userId } } });
  }
  if (query.status !== 'all') conditions.push({ isActive: query.status === 'active' });
  if (query.search) {
    conditions.push({
      OR: [
        { code: { contains: query.search, mode: 'insensitive' } },
        { name: { contains: query.search, mode: 'insensitive' } },
      ],
    });
  }
  return { AND: conditions };
}

export class OutletRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(
    query: OutletListQuery,
    scope: OutletListScope,
  ): Promise<{ items: Outlet[]; total: number }> {
    const where = listWhere(query, scope);
    const [items, total] = await this.database.$transaction([
      this.database.outlet.findMany({
        where,
        select: outletSelect,
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.database.outlet.count({ where }),
    ]);
    return { items, total };
  }

  public findById(id: string): Promise<Outlet | null> {
    return this.database.outlet.findUnique({ where: { id }, select: outletSelect });
  }

  public createWithReceiptCounter(input: CreateOutletInput): Promise<Outlet> {
    return this.database.$transaction(async (transaction) => {
      const outlet = await transaction.outlet.create({ data: input, select: outletSelect });
      await transaction.receiptCounter.create({ data: { outletId: outlet.id, lastNumber: 0 } });
      return outlet;
    });
  }

  public update(id: string, input: UpdateOutletInput): Promise<Outlet> {
    const data: Prisma.OutletUpdateInput = {
      ...(input.name !== undefined && { name: input.name }),
      ...(input.address !== undefined && { address: input.address }),
    };
    return this.database.outlet.update({ where: { id }, data, select: outletSelect });
  }

  public setActive(id: string, isActive: boolean): Promise<Outlet> {
    return this.database.outlet.update({ where: { id }, data: { isActive }, select: outletSelect });
  }
}
