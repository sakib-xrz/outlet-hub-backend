import type { DatabaseClient, DatabaseExecutor } from '@/database/client.js';
import { type LockedUser, lockUser } from '@/database/locks.js';
import { Prisma, SessionRevokeReason } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import type {
  OutletCheckResult,
  StaffDetail,
  StaffListQuery,
  StaffSummary,
} from '@/modules/staff/staff.types.js';

const identitySelect = {
  id: true,
  email: true,
  role: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserSelect;

export type StaffMutationResult<T = undefined> =
  | { kind: 'not-found' }
  | { kind: 'invalid-outlets'; outletIds: string[] }
  | { kind: 'ok'; value: T };

function listWhere(query: StaffListQuery): Prisma.UserWhereInput {
  return {
    role: Role.OUTLET_STAFF,
    ...(query.status !== 'all' && { isActive: query.status === 'active' }),
    ...(query.search && { email: { contains: query.search, mode: 'insensitive' } }),
    ...(query.outletId && { memberships: { some: { outletId: query.outletId } } }),
  };
}

async function lockActiveOutlets(
  client: DatabaseExecutor,
  outletIds: readonly string[],
): Promise<OutletCheckResult> {
  if (outletIds.length === 0) return { kind: 'ok' };
  const ids = [...outletIds].sort();
  const rows = await client.$queryRaw<{ id: string; is_active: boolean }[]>`
    SELECT id, is_active FROM outlets
    WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR SHARE`;
  const active = new Set(rows.filter((row) => row.is_active).map((row) => row.id));
  const invalid = ids.filter((id) => !active.has(id));
  return invalid.length ? { kind: 'invalid-outlets', outletIds: invalid } : { kind: 'ok' };
}

function revokeSessions(client: DatabaseExecutor, userId: string): Promise<Prisma.BatchPayload> {
  return client.refreshSession.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date(), revokeReason: SessionRevokeReason.ADMIN_REVOKED },
  });
}

async function lockStaff(client: DatabaseExecutor, staffId: string): Promise<LockedUser | null> {
  const user = await lockUser(client, staffId, 'update');
  return user?.role === Role.OUTLET_STAFF ? user : null;
}

export class StaffRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async list(query: StaffListQuery): Promise<{ items: StaffSummary[]; total: number }> {
    const where = listWhere(query);
    const [rows, total] = await this.database.$transaction([
      this.database.user.findMany({
        where,
        select: { ...identitySelect, _count: { select: { memberships: true } } },
        orderBy: [{ [query.sortBy]: query.sortOrder }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
      }),
      this.database.user.count({ where }),
    ]);
    const items = rows.map(({ _count, ...identity }) => ({
      ...identity,
      outletCount: _count.memberships,
    }));
    return { items, total };
  }

  public async findById(staffId: string): Promise<StaffDetail | null> {
    const user = await this.database.user.findFirst({
      where: { id: staffId, role: Role.OUTLET_STAFF },
      select: {
        ...identitySelect,
        memberships: {
          select: { outlet: { select: { id: true, code: true, name: true, isActive: true } } },
          orderBy: { outlet: { code: 'asc' } },
        },
      },
    });
    if (!user) return null;
    const { memberships, ...identity } = user;
    return { ...identity, outlets: memberships.map(({ outlet }) => outlet) };
  }

  public create(input: {
    email: string;
    passwordHash: string;
    outletIds: string[];
  }): Promise<StaffMutationResult<string>> {
    return this.database.$transaction(async (transaction) => {
      const outlets = await lockActiveOutlets(transaction, input.outletIds);
      if (outlets.kind === 'invalid-outlets') return outlets;

      const user = await transaction.user.create({
        data: {
          email: input.email,
          passwordHash: input.passwordHash,
          role: Role.OUTLET_STAFF,
          isActive: true,
        },
        select: { id: true },
      });
      if (input.outletIds.length) {
        await transaction.outletMembership.createMany({
          data: input.outletIds.map((outletId) => ({ userId: user.id, outletId })),
        });
      }
      return { kind: 'ok', value: user.id };
    });
  }

  public async updateEmail(staffId: string, email: string): Promise<boolean> {
    const result = await this.database.user.updateMany({
      where: { id: staffId, role: Role.OUTLET_STAFF },
      data: { email },
    });
    return result.count === 1;
  }

  public setActive(staffId: string, isActive: boolean): Promise<StaffMutationResult> {
    return this.database.$transaction(async (transaction) => {
      const staff = await lockStaff(transaction, staffId);
      if (!staff) return { kind: 'not-found' };
      if (staff.isActive !== isActive) {
        await transaction.user.update({ where: { id: staffId }, data: { isActive } });
        if (!isActive) await revokeSessions(transaction, staffId);
      }
      return { kind: 'ok', value: undefined };
    });
  }

  public resetPassword(staffId: string, passwordHash: string): Promise<StaffMutationResult> {
    return this.database.$transaction(async (transaction) => {
      const staff = await lockStaff(transaction, staffId);
      if (!staff) return { kind: 'not-found' };
      await transaction.user.update({ where: { id: staffId }, data: { passwordHash } });
      await revokeSessions(transaction, staffId);
      return { kind: 'ok', value: undefined };
    });
  }

  public replaceOutlets(staffId: string, outletIds: string[]): Promise<StaffMutationResult> {
    return this.database.$transaction(async (transaction) => {
      const staff = await lockStaff(transaction, staffId);
      if (!staff) return { kind: 'not-found' };

      const current = await transaction.outletMembership.findMany({
        where: { userId: staffId },
        select: { outletId: true },
      });
      const currentIds = new Set(current.map(({ outletId }) => outletId));
      const requested = new Set(outletIds);
      const additions = outletIds.filter((id) => !currentIds.has(id));
      const removals = [...currentIds].filter((id) => !requested.has(id));

      const outlets = await lockActiveOutlets(transaction, additions);
      if (outlets.kind === 'invalid-outlets') return outlets;

      if (removals.length) {
        await transaction.outletMembership.deleteMany({
          where: { userId: staffId, outletId: { in: removals } },
        });
      }
      if (additions.length) {
        await transaction.outletMembership.createMany({
          data: additions.map((outletId) => ({ userId: staffId, outletId })),
        });
      }
      return { kind: 'ok', value: undefined };
    });
  }
}
