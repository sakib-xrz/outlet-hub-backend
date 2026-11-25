import { BadRequestError, ConflictError, NotFoundError } from '@/common/errors/app-error.js';
import { hashPassword } from '@/common/security/password.js';
import { Prisma } from '@/generated/prisma/client.js';
import type { StaffMutationResult, StaffRepository } from '@/modules/staff/staff.repository.js';
import type {
  CreateStaffInput,
  StaffDetail,
  StaffListQuery,
  StaffSummary,
} from '@/modules/staff/staff.types.js';
import type { Paginated } from '@/modules/outlets/outlet.types.js';

export type StaffStore = Pick<
  StaffRepository,
  'list' | 'findById' | 'create' | 'updateEmail' | 'setActive' | 'resetPassword' | 'replaceOutlets'
>;

const duplicateEmail = (): ConflictError =>
  new ConflictError('A user with this email already exists', [
    { field: 'body.email', message: 'This email address is already in use' },
  ]);

function unwrap<T>(result: StaffMutationResult<T>): T {
  if (result.kind === 'not-found') throw new NotFoundError('Staff member not found');
  if (result.kind === 'invalid-outlets') {
    throw new BadRequestError('Validation failed', 'VALIDATION_ERROR', [
      {
        field: 'body.outletIds',
        message: `These outlets do not exist or are inactive: ${result.outletIds.join(', ')}`,
      },
    ]);
  }
  return result.value;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class StaffService {
  public constructor(private readonly repository: StaffStore) {}

  public async list(query: StaffListQuery): Promise<Paginated<StaffSummary>> {
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

  public async getById(staffId: string): Promise<StaffDetail> {
    const staff = await this.repository.findById(staffId);
    if (!staff) throw new NotFoundError('Staff member not found');
    return staff;
  }

  public async create(input: CreateStaffInput): Promise<StaffDetail> {
    const passwordHash = await hashPassword(input.password);
    let staffId: string;
    try {
      staffId = unwrap(
        await this.repository.create({
          email: input.email,
          passwordHash,
          outletIds: input.outletIds,
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateEmail();
      throw error;
    }
    return this.getById(staffId);
  }

  public async updateEmail(staffId: string, email: string): Promise<StaffDetail> {
    try {
      if (!(await this.repository.updateEmail(staffId, email))) {
        throw new NotFoundError('Staff member not found');
      }
    } catch (error) {
      if (isUniqueViolation(error)) throw duplicateEmail();
      throw error;
    }
    return this.getById(staffId);
  }

  public async setStatus(staffId: string, isActive: boolean): Promise<StaffDetail> {
    unwrap(await this.repository.setActive(staffId, isActive));
    return this.getById(staffId);
  }

  public async resetPassword(staffId: string, newPassword: string): Promise<void> {
    const passwordHash = await hashPassword(newPassword);
    unwrap(await this.repository.resetPassword(staffId, passwordHash));
  }

  public async replaceOutlets(staffId: string, outletIds: string[]): Promise<StaffDetail> {
    unwrap(await this.repository.replaceOutlets(staffId, outletIds));
    return this.getById(staffId);
  }
}
