import type { DatabaseExecutor } from '@/database/client.js';

export type LockedUser = { id: string; role: string; isActive: boolean; passwordHash: string };

type LockedUserRow = { id: string; role: string; is_active: boolean; password_hash: string };

export async function lockUser(
  client: DatabaseExecutor,
  userId: string,
  mode: 'share' | 'update',
): Promise<LockedUser | null> {
  const rows =
    mode === 'update'
      ? await client.$queryRaw<LockedUserRow[]>`
          SELECT id, role::text AS role, is_active, password_hash
          FROM users WHERE id = ${userId}::uuid FOR UPDATE`
      : await client.$queryRaw<LockedUserRow[]>`
          SELECT id, role::text AS role, is_active, password_hash
          FROM users WHERE id = ${userId}::uuid FOR SHARE`;
  const row = rows[0];
  return row
    ? { id: row.id, role: row.role, isActive: row.is_active, passwordHash: row.password_hash }
    : null;
}
