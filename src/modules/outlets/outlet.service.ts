import { ConflictError, NotFoundError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type { OutletRepository } from '@/modules/outlets/outlet.repository.js';
import type {
  CreateOutletInput,
  Outlet,
  OutletListQuery,
  Paginated,
  UpdateOutletInput,
} from '@/modules/outlets/outlet.types.js';

export type OutletStore = Pick<
  OutletRepository,
  'list' | 'findById' | 'createWithReceiptCounter' | 'update' | 'setActive'
>;

function isPrismaError(error: unknown, code: string): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;
}

export class OutletService {
  public constructor(private readonly repository: OutletStore) {}

  public async list(user: AuthenticatedUser, query: OutletListQuery): Promise<Paginated<Outlet>> {
    const scope =
      user.role === Role.HQ_ADMIN
        ? ({ kind: 'all' } as const)
        : ({ kind: 'member', userId: user.id } as const);
    const { items, total } = await this.repository.list(query, scope);
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

  public async getById(id: string): Promise<Outlet> {
    const outlet = await this.repository.findById(id);
    if (!outlet) throw new NotFoundError('Outlet not found');
    return outlet;
  }

  public async create(input: CreateOutletInput): Promise<Outlet> {
    try {
      return await this.repository.createWithReceiptCounter(input);
    } catch (error) {
      if (isPrismaError(error, 'P2002')) {
        throw new ConflictError('An outlet with this code already exists', [
          { field: 'body.code', message: 'This outlet code is already in use' },
        ]);
      }
      throw error;
    }
  }

  public async update(id: string, input: UpdateOutletInput): Promise<Outlet> {
    try {
      return await this.repository.update(id, input);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) throw new NotFoundError('Outlet not found');
      throw error;
    }
  }

  public async setStatus(id: string, isActive: boolean): Promise<Outlet> {
    const current = await this.getById(id);
    if (current.isActive === isActive) return current;
    try {
      return await this.repository.setActive(id, isActive);
    } catch (error) {
      if (isPrismaError(error, 'P2025')) throw new NotFoundError('Outlet not found');
      throw error;
    }
  }
}
