import { describe, expect, it, type Mock, vi } from 'vitest';
import type { DatabaseClient } from '@/database/client.js';
import { AuthRepository } from '@/modules/auth/auth.repository.js';

const input = {
  tokenHash: 'a'.repeat(64),
  userId: 'user-1',
  familyId: 'family-1',
  expiresAt: new Date(Date.now() + 60_000),
};

function database(locked: { is_active: boolean; password_hash: string } | null): {
  client: DatabaseClient;
  create: Mock;
  queryRaw: Mock;
} {
  const create = vi.fn(() => Promise.resolve({}));
  const queryRaw = vi.fn(() =>
    Promise.resolve(locked ? [{ id: 'user-1', role: 'OUTLET_STAFF', ...locked }] : []),
  );
  const transaction = { $queryRaw: queryRaw, refreshSession: { create } };
  const client = {
    $transaction: vi.fn((callback: (tx: typeof transaction) => Promise<unknown>) =>
      callback(transaction),
    ),
  } as unknown as DatabaseClient;
  return { client, create, queryRaw };
}

describe('AuthRepository.createSession (login vs. password reset / deactivation)', () => {
  it('creates the session while holding a shared lock on an unchanged, active user', async () => {
    const db = database({ is_active: true, password_hash: 'verified-hash' });
    await expect(new AuthRepository(db.client).createSession(input, 'verified-hash')).resolves.toBe(
      true,
    );
    expect(db.create).toHaveBeenCalledWith({ data: input });
    const sql = (db.queryRaw.mock.calls[0] as unknown as [TemplateStringsArray])[0].join('?');
    expect(sql).toContain('FOR SHARE');
  });

  it('refuses a session when the password changed after it was verified', async () => {
    const db = database({ is_active: true, password_hash: 'reset-hash' });
    await expect(new AuthRepository(db.client).createSession(input, 'verified-hash')).resolves.toBe(
      false,
    );
    expect(db.create).not.toHaveBeenCalled();
  });

  it('refuses a session when the account was deactivated or deleted meanwhile', async () => {
    const inactive = database({ is_active: false, password_hash: 'verified-hash' });
    await expect(
      new AuthRepository(inactive.client).createSession(input, 'verified-hash'),
    ).resolves.toBe(false);
    const missing = database(null);
    await expect(
      new AuthRepository(missing.client).createSession(input, 'verified-hash'),
    ).resolves.toBe(false);
    expect(inactive.create).not.toHaveBeenCalled();
    expect(missing.create).not.toHaveBeenCalled();
  });
});
