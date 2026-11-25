import { AuthorizationError, NotFoundError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Role } from '@/generated/prisma/enums.js';
import type { DatabaseExecutor } from '@/database/client.js';
import type { OutletAccessRepository } from '@/modules/access/outlet-access.repository.js';

export type OutletAccessStore = Pick<
  OutletAccessRepository,
  'outletExists' | 'hasActiveMembership'
>;

export class OutletAccessService {
  public constructor(private readonly repository: OutletAccessStore) {}

  public async assertCanAccessOutlet(
    user: AuthenticatedUser,
    outletId: string,
    client?: DatabaseExecutor,
  ): Promise<void> {
    if (user.role === Role.HQ_ADMIN) {
      if (!(await this.repository.outletExists(outletId, client)))
        throw new NotFoundError('Outlet not found');
      return;
    }
    if (!(await this.repository.hasActiveMembership(user.id, outletId, client)))
      throw new AuthorizationError('You do not have access to this outlet');
  }
}
