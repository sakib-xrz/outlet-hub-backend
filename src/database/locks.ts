import type { DatabaseExecutor } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';

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

export async function lockReceiptCounter(
  client: DatabaseExecutor,
  outletId: string,
): Promise<{ lastNumber: number } | null> {
  const rows = await client.$queryRaw<{ last_number: number }[]>`
    SELECT last_number FROM receipt_counters WHERE outlet_id = ${outletId}::uuid FOR UPDATE`;
  const row = rows[0];
  return row ? { lastNumber: row.last_number } : null;
}

export async function incrementReceiptCounter(
  client: DatabaseExecutor,
  outletId: string,
): Promise<number> {
  const rows = await client.$queryRaw<{ last_number: number }[]>`
    UPDATE receipt_counters SET last_number = last_number + 1
    WHERE outlet_id = ${outletId}::uuid
    RETURNING last_number`;
  const row = rows[0];
  if (!row) throw new Error('Receipt counter disappeared during the sale transaction');
  return row.last_number;
}

export type LockedAssignment = {
  menuItemId: string;
  isActive: boolean;
  stockQuantity: number;
  overridePrice: string | null;
};

export async function lockOutletMenuItems(
  client: DatabaseExecutor,
  outletId: string,
  menuItemIds: readonly string[],
): Promise<LockedAssignment[]> {
  if (menuItemIds.length === 0) return [];
  const rows = await client.$queryRaw<
    {
      menu_item_id: string;
      is_active: boolean;
      stock_quantity: number;
      override_price: string | null;
    }[]
  >`
    SELECT menu_item_id, is_active, stock_quantity, override_price::text AS override_price
    FROM outlet_menu_items
    WHERE outlet_id = ${outletId}::uuid
      AND menu_item_id IN (${Prisma.join(menuItemIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY menu_item_id
    FOR UPDATE`;
  return rows.map((row) => ({
    menuItemId: row.menu_item_id,
    isActive: row.is_active,
    stockQuantity: row.stock_quantity,
    overridePrice: row.override_price,
  }));
}

export type LockedMenuItem = { id: string; name: string; basePrice: string; isActive: boolean };

export async function lockMenuItemsShared(
  client: DatabaseExecutor,
  menuItemIds: readonly string[],
): Promise<LockedMenuItem[]> {
  if (menuItemIds.length === 0) return [];
  const rows = await client.$queryRaw<
    { id: string; name: string; base_price: string; is_active: boolean }[]
  >`
    SELECT id, name, base_price::text AS base_price, is_active
    FROM menu_items
    WHERE id IN (${Prisma.join(menuItemIds.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY id
    FOR SHARE`;
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    basePrice: row.base_price,
    isActive: row.is_active,
  }));
}
