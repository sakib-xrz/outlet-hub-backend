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

export async function lockOutletShared(
  client: DatabaseExecutor,
  outletId: string,
): Promise<{ isActive: boolean } | null> {
  const rows = await client.$queryRaw<{ is_active: boolean }[]>`
    SELECT is_active FROM outlets WHERE id = ${outletId}::uuid FOR SHARE`;
  const row = rows[0];
  return row ? { isActive: row.is_active } : null;
}

export async function lockOutletMenuItem(
  client: DatabaseExecutor,
  outletId: string,
  menuItemId: string,
): Promise<{ isActive: boolean; stockQuantity: number } | null> {
  const rows = await client.$queryRaw<{ is_active: boolean; stock_quantity: number }[]>`
    SELECT is_active, stock_quantity FROM outlet_menu_items
    WHERE outlet_id = ${outletId}::uuid AND menu_item_id = ${menuItemId}::uuid
    FOR UPDATE`;
  const row = rows[0];
  return row ? { isActive: row.is_active, stockQuantity: row.stock_quantity } : null;
}

export async function lockMenuItemShared(
  client: DatabaseExecutor,
  menuItemId: string,
): Promise<{ isActive: boolean } | null> {
  const rows = await client.$queryRaw<{ is_active: boolean }[]>`
    SELECT is_active FROM menu_items WHERE id = ${menuItemId}::uuid FOR SHARE`;
  const row = rows[0];
  return row ? { isActive: row.is_active } : null;
}

export async function lockActiveHqAdmin(
  client: DatabaseExecutor,
  userId: string,
): Promise<boolean> {
  const user = await lockUser(client, userId, 'share');
  return user?.isActive === true && user.role === 'HQ_ADMIN';
}
