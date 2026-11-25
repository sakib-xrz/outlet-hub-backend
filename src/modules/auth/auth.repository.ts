import type { DatabaseClient } from '@/database/client.js';
import { lockUser } from '@/database/locks.js';
import { Prisma, SessionRevokeReason } from '@/generated/prisma/client.js';
import type { Role } from '@/generated/prisma/enums.js';

export type AuthUser = {
  id: string;
  email: string;
  passwordHash: string;
  role: Role;
  isActive: boolean;
};

export type RotationResult =
  | { kind: 'rotated'; user: Omit<AuthUser, 'passwordHash' | 'isActive'> }
  | { kind: 'invalid' }
  | { kind: 'replay' };

type CreateSessionInput = {
  tokenHash: string;
  userId: string;
  familyId: string;
  expiresAt: Date;
  ipAddress?: string;
  userAgent?: string;
};

type RotateInput = Omit<CreateSessionInput, 'userId' | 'familyId'>;

const userSelect = {
  id: true,
  email: true,
  passwordHash: true,
  role: true,
  isActive: true,
} satisfies Prisma.UserSelect;

export class AuthRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public findUserByEmail(email: string): Promise<AuthUser | null> {
    return this.database.user.findUnique({ where: { email }, select: userSelect });
  }

  public findActiveUserById(
    id: string,
  ): Promise<Omit<AuthUser, 'passwordHash' | 'isActive'> | null> {
    return this.database.user.findFirst({
      where: { id, isActive: true },
      select: { id: true, email: true, role: true },
    });
  }

  public createSession(input: CreateSessionInput, verifiedPasswordHash: string): Promise<boolean> {
    return this.database.$transaction(async (transaction) => {
      const user = await lockUser(transaction, input.userId, 'share');
      if (!user?.isActive || user.passwordHash !== verifiedPasswordHash) return false;
      await transaction.refreshSession.create({ data: input });
      return true;
    });
  }

  public async rotateSession(
    currentHash: string,
    replacement: RotateInput,
  ): Promise<RotationResult> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await this.database.$transaction(
          async (transaction) => {
            const current = await transaction.refreshSession.findUnique({
              where: { tokenHash: currentHash },
              include: { user: { select: userSelect } },
            });
            if (!current) return { kind: 'invalid' } as const;
            const owner = await lockUser(transaction, current.userId, 'share');
            if (!owner) return { kind: 'invalid' } as const;

            const now = new Date();
            if (current.revokedAt) {
              if (current.revokeReason === SessionRevokeReason.ROTATED) {
                await transaction.refreshSession.updateMany({
                  where: { familyId: current.familyId, revokedAt: null },
                  data: { revokedAt: now, revokeReason: SessionRevokeReason.REPLAY_DETECTED },
                });
                return { kind: 'replay' } as const;
              }
              return { kind: 'invalid' } as const;
            }
            if (current.expiresAt <= now || !owner.isActive) {
              await transaction.refreshSession.updateMany({
                where: { id: current.id, revokedAt: null },
                data: { revokedAt: now, revokeReason: SessionRevokeReason.EXPIRED },
              });
              return { kind: 'invalid' } as const;
            }

            const claimed = await transaction.refreshSession.updateMany({
              where: { id: current.id, revokedAt: null },
              data: { revokedAt: now, revokeReason: SessionRevokeReason.ROTATED, lastUsedAt: now },
            });
            if (claimed.count !== 1)
              throw new Prisma.PrismaClientKnownRequestError('Concurrent refresh', {
                code: 'P2034',
                clientVersion: '7',
              });

            await transaction.refreshSession.create({
              data: {
                ...replacement,
                userId: current.userId,
                familyId: current.familyId,
              },
            });
            return {
              kind: 'rotated',
              user: { id: current.user.id, email: current.user.email, role: current.user.role },
            } as const;
          },
          { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
        );
      } catch (error) {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          error.code === 'P2034' &&
          attempt === 0
        )
          continue;
        throw error;
      }
    }
    return { kind: 'invalid' };
  }

  public async revokeSession(tokenHash: string): Promise<void> {
    await this.database.refreshSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt: new Date(), revokeReason: SessionRevokeReason.LOGOUT },
    });
  }
}
