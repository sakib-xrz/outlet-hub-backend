import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { SessionRevokeReason } from '@/generated/prisma/client.js';
import { StaffRepository } from '@/modules/staff/staff.repository.js';

const STAFF = 'staff-1';

type Fake = {
  database: DatabaseClient;
  calls: string[];
  queryRaw: Mock;
  userCreate: Mock;
  userUpdate: Mock;
  membershipCreateMany: Mock;
  membershipDeleteMany: Mock;
  sessionUpdateMany: Mock;
};

function fake(options: {
  staff?: { role: string; isActive: boolean } | null;
  activeOutlets?: string[];
  memberships?: string[];
}): Fake {
  const calls: string[] = [];
  const staff =
    options.staff === undefined ? { role: 'OUTLET_STAFF', isActive: true } : options.staff;
  const queryRaw = vi.fn((strings: TemplateStringsArray) => {
    const sql = strings.join('?');
    if (sql.includes('FROM users')) {
      calls.push(sql.includes('FOR UPDATE') ? 'lock-user-update' : 'lock-user-share');
      return Promise.resolve(
        staff
          ? [{ id: STAFF, role: staff.role, is_active: staff.isActive, password_hash: 'h' }]
          : [],
      );
    }
    calls.push('lock-outlets');
    return Promise.resolve((options.activeOutlets ?? []).map((id) => ({ id, is_active: true })));
  });
  const record = (name: string, value: unknown = {}): Mock =>
    vi.fn(() => {
      calls.push(name);
      return Promise.resolve(value);
    });
  const userCreate = record('user.create', { id: STAFF });
  const userUpdate = record('user.update');
  const membershipCreateMany = record('membership.createMany');
  const membershipDeleteMany = record('membership.deleteMany');
  const sessionUpdateMany = record('session.revoke', { count: 2 });
  const transaction = {
    $queryRaw: queryRaw,
    user: { create: userCreate, update: userUpdate },
    outletMembership: {
      createMany: membershipCreateMany,
      deleteMany: membershipDeleteMany,
      findMany: vi.fn(() =>
        Promise.resolve((options.memberships ?? []).map((outletId) => ({ outletId }))),
      ),
    },
    refreshSession: { updateMany: sessionUpdateMany },
  };
  const database = {
    $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  return {
    database,
    calls,
    queryRaw,
    userCreate,
    userUpdate,
    membershipCreateMany,
    membershipDeleteMany,
    sessionUpdateMany,
  };
}

describe('StaffRepository.create (mocked transaction orchestration)', () => {
  it('locks outlets, then creates the user and memberships in one transaction', async () => {
    const db = fake({ activeOutlets: ['o-1', 'o-2'] });
    const result = await new StaffRepository(db.database).create({
      email: 'a@b.co',
      passwordHash: '$argon2id$hash',
      outletIds: ['o-2', 'o-1'],
    });
    expect(result).toEqual({ kind: 'ok', value: STAFF });
    expect(db.calls).toEqual(['lock-outlets', 'user.create', 'membership.createMany']);
    expect(db.userCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          email: 'a@b.co',
          passwordHash: '$argon2id$hash',
          role: 'OUTLET_STAFF',
          isActive: true,
        },
      }),
    );
  });

  it('creates nothing when an outlet is missing or inactive', async () => {
    const db = fake({ activeOutlets: ['o-1'] });
    const result = await new StaffRepository(db.database).create({
      email: 'a@b.co',
      passwordHash: 'h',
      outletIds: ['o-1', 'o-9'],
    });
    expect(result).toEqual({ kind: 'invalid-outlets', outletIds: ['o-9'] });
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it('propagates membership failures so the transaction rolls back', async () => {
    const db = fake({ activeOutlets: ['o-1'] });
    db.membershipCreateMany.mockRejectedValueOnce(new Error('membership failed'));
    await expect(
      new StaffRepository(db.database).create({
        email: 'a@b.co',
        passwordHash: 'h',
        outletIds: ['o-1'],
      }),
    ).rejects.toThrow('membership failed');
  });
});

describe('StaffRepository.replaceOutlets', () => {
  it('locks the staff row first and only changes the difference', async () => {
    const db = fake({ memberships: ['o-a', 'o-b'], activeOutlets: ['o-c'] });
    await new StaffRepository(db.database).replaceOutlets(STAFF, ['o-b', 'o-c']);

    expect(db.calls).toEqual([
      'lock-user-update',
      'lock-outlets',
      'membership.deleteMany',
      'membership.createMany',
    ]);
    expect(db.membershipDeleteMany).toHaveBeenCalledWith({
      where: { userId: STAFF, outletId: { in: ['o-a'] } },
    });
    expect(db.membershipCreateMany).toHaveBeenCalledWith({
      data: [{ userId: STAFF, outletId: 'o-c' }],
    });
  });

  it('keeps retained inactive outlets without re-validating them', async () => {
    const db = fake({ memberships: ['inactive-outlet'], activeOutlets: [] });
    const result = await new StaffRepository(db.database).replaceOutlets(STAFF, [
      'inactive-outlet',
    ]);
    expect(result.kind).toBe('ok');
    expect(db.calls).toEqual(['lock-user-update']);
  });

  it('removes every membership for an empty set', async () => {
    const db = fake({ memberships: ['o-a', 'o-b'] });
    await new StaffRepository(db.database).replaceOutlets(STAFF, []);
    expect(db.membershipDeleteMany).toHaveBeenCalledWith({
      where: { userId: STAFF, outletId: { in: ['o-a', 'o-b'] } },
    });
    expect(db.membershipCreateMany).not.toHaveBeenCalled();
  });

  it('rejects new inactive outlets without changing anything', async () => {
    const db = fake({ memberships: ['o-a'], activeOutlets: [] });
    const result = await new StaffRepository(db.database).replaceOutlets(STAFF, ['o-new']);
    expect(result).toEqual({ kind: 'invalid-outlets', outletIds: ['o-new'] });
    expect(db.membershipDeleteMany).not.toHaveBeenCalled();
  });

  it('never touches HQ administrators', async () => {
    const db = fake({ staff: { role: 'HQ_ADMIN', isActive: true } });
    const result = await new StaffRepository(db.database).replaceOutlets(STAFF, []);
    expect(result).toEqual({ kind: 'not-found' });
    expect(db.calls).toEqual(['lock-user-update']);
  });
});

describe('StaffRepository status and password changes', () => {
  it('deactivates and revokes sessions atomically', async () => {
    const db = fake({});
    await new StaffRepository(db.database).setActive(STAFF, false);
    expect(db.calls).toEqual(['lock-user-update', 'user.update', 'session.revoke']);
    expect(db.sessionUpdateMany).toHaveBeenCalledWith({
      where: { userId: STAFF, revokedAt: null },
      data: { revokedAt: expect.any(Date), revokeReason: SessionRevokeReason.ADMIN_REVOKED },
    });
  });

  it('reactivates without restoring sessions and is idempotent', async () => {
    const inactive = fake({ staff: { role: 'OUTLET_STAFF', isActive: false } });
    await new StaffRepository(inactive.database).setActive(STAFF, true);
    expect(inactive.calls).toEqual(['lock-user-update', 'user.update']);

    const unchanged = fake({});
    await new StaffRepository(unchanged.database).setActive(STAFF, true);
    expect(unchanged.calls).toEqual(['lock-user-update']);
  });

  it('replaces the password hash and revokes sessions in one transaction', async () => {
    const db = fake({});
    await new StaffRepository(db.database).resetPassword(STAFF, 'new-hash');
    expect(db.calls).toEqual(['lock-user-update', 'user.update', 'session.revoke']);
    expect(db.userUpdate).toHaveBeenCalledWith({
      where: { id: STAFF },
      data: { passwordHash: 'new-hash' },
    });
  });

  it('refuses HQ administrator targets', async () => {
    const db = fake({ staff: { role: 'HQ_ADMIN', isActive: true } });
    await expect(new StaffRepository(db.database).resetPassword(STAFF, 'h')).resolves.toEqual({
      kind: 'not-found',
    });
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});
