import type { DatabaseClient } from '@/database/client.js';
import type { Prisma } from '@/generated/prisma/client.js';

export type DatabaseExecutor = DatabaseClient | Prisma.TransactionClient;

export class OutletAccessRepository {
  public constructor(private readonly database: DatabaseClient) {}

  public async outletExists(
    outletId: string,
    client: DatabaseExecutor = this.database,
  ): Promise<boolean> {
    const outlet = await client.outlet.findUnique({
      where: { id: outletId },
      select: { id: true },
    });
    return outlet !== null;
  }

  public async hasActiveMembership(
    userId: string,
    outletId: string,
    client: DatabaseExecutor = this.database,
  ): Promise<boolean> {
    const membership = await client.outletMembership.findFirst({
      where: { userId, outletId, outlet: { isActive: true } },
      select: { outletId: true },
    });
    return membership !== null;
  }
}
