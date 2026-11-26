/**
 * One-time migration: strip the DEMO- prefix from all seed data rows.
 * Outlet codes are immutable via the API, so this script operates directly
 * on the database. Run with --apply to execute; default is dry-run only.
 *
 * Usage:
 *   pnpm tsx scripts/remove-demo-prefix.ts           # dry run
 *   pnpm tsx scripts/remove-demo-prefix.ts --apply   # backup + apply
 */
import '@/config/load-env.js';
import { execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '@/config/env.js';
import { createPrismaClient } from '@/database/client.js';
import { Prisma } from '@/generated/prisma/client.js';

const APPLY = process.argv.includes('--apply');
const config = loadConfig();
const db = createPrismaClient({ ...config, DATABASE_POOL_MAX: 3 });

// ── 1. Collect planned changes ────────────────────────────────────────────────

type Change =
  | {
      kind: 'row';
      table: string;
      rowId: string;
      column: string;
      sqlColumn: string;
      from: string;
      to: string;
    }
  | { kind: 'sale_item'; saleId: string; menuItemId: string; from: string; to: string };

function stripDemoPrefix(value: string): string {
  return value.replace(/^DEMO-/i, '');
}

function stripDemoWord(value: string): string {
  return value.replace(/\bDemo\s+/gi, '').trim();
}

async function collectChanges(): Promise<Change[]> {
  const changes: Change[] = [];

  const outlets = await db.outlet.findMany({
    select: { id: true, code: true, name: true, address: true },
  });
  for (const row of outlets) {
    if (/demo/i.test(row.code)) {
      changes.push({
        kind: 'row',
        table: 'outlets',
        rowId: row.id,
        column: 'code',
        sqlColumn: 'code',
        from: row.code,
        to: stripDemoPrefix(row.code),
      });
    }
    if (/demo/i.test(row.name)) {
      changes.push({
        kind: 'row',
        table: 'outlets',
        rowId: row.id,
        column: 'name',
        sqlColumn: 'name',
        from: row.name,
        to: stripDemoWord(row.name),
      });
    }
    if (row.address && /demo/i.test(row.address)) {
      changes.push({
        kind: 'row',
        table: 'outlets',
        rowId: row.id,
        column: 'address',
        sqlColumn: 'address',
        from: row.address,
        to: stripDemoWord(row.address),
      });
    }
  }

  const items = await db.menuItem.findMany({
    select: { id: true, sku: true, name: true, description: true },
  });
  for (const row of items) {
    if (/demo/i.test(row.sku)) {
      changes.push({
        kind: 'row',
        table: 'menu_items',
        rowId: row.id,
        column: 'sku',
        sqlColumn: 'sku',
        from: row.sku,
        to: stripDemoPrefix(row.sku),
      });
    }
    if (/demo/i.test(row.name)) {
      changes.push({
        kind: 'row',
        table: 'menu_items',
        rowId: row.id,
        column: 'name',
        sqlColumn: 'name',
        from: row.name,
        to: stripDemoWord(row.name),
      });
    }
    if (row.description && /demo/i.test(row.description)) {
      changes.push({
        kind: 'row',
        table: 'menu_items',
        rowId: row.id,
        column: 'description',
        sqlColumn: 'description',
        from: row.description,
        to: stripDemoWord(row.description),
      });
    }
  }

  // sale_items.item_name is denormalized; PK is composite [saleId, menuItemId]
  const saleItems = await db.saleItem.findMany({
    where: { itemName: { contains: 'demo', mode: 'insensitive' } },
    select: { saleId: true, menuItemId: true, itemName: true },
  });
  for (const row of saleItems) {
    changes.push({
      kind: 'sale_item',
      saleId: row.saleId,
      menuItemId: row.menuItemId,
      from: row.itemName,
      to: stripDemoWord(row.itemName),
    });
  }

  const users = await db.user.findMany({
    where: { email: { contains: 'demo', mode: 'insensitive' } },
    select: { id: true, email: true },
  });
  for (const row of users) {
    changes.push({
      kind: 'row',
      table: 'users',
      rowId: row.id,
      column: 'email',
      sqlColumn: 'email',
      from: row.email,
      to: stripDemoWord(row.email).toLowerCase(),
    });
  }

  return changes;
}

// ── 2. Check for unique-constraint collisions ─────────────────────────────────

async function checkCollisions(changes: Change[]): Promise<string[]> {
  const errors: string[] = [];

  for (const change of changes) {
    if (change.kind !== 'row') continue;
    if (change.table === 'outlets' && change.column === 'code') {
      const existing = await db.outlet.findFirst({
        where: { code: change.to, NOT: { id: change.rowId } },
      });
      if (existing)
        errors.push(`outlets.code collision: "${change.to}" already exists (id=${existing.id})`);
    }
    if (change.table === 'menu_items' && change.column === 'sku') {
      const existing = await db.menuItem.findFirst({
        where: { sku: change.to, NOT: { id: change.rowId } },
      });
      if (existing)
        errors.push(`menu_items.sku collision: "${change.to}" already exists (id=${existing.id})`);
    }
    if (change.table === 'users' && change.column === 'email') {
      const existing = await db.user.findFirst({
        where: { email: change.to, NOT: { id: change.rowId } },
      });
      if (existing)
        errors.push(`users.email collision: "${change.to}" already exists (id=${existing.id})`);
    }
  }

  return errors;
}

// ── 3. Backup ─────────────────────────────────────────────────────────────────

function backup(databaseUrl: string): string {
  const dir = join(homedir(), 'Work', '_db-backups');
  mkdirSync(dir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const path = join(dir, `outlethub-${timestamp}.sql`);
  const pgDump =
    process.env.PG_DUMP_PATH ??
    [
      '/Library/PostgreSQL/18/bin/pg_dump',
      '/usr/local/bin/pg_dump',
      '/opt/homebrew/bin/pg_dump',
      'pg_dump',
    ].find((p) => {
      try {
        execSync(`"${p}" --version`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    }) ??
    'pg_dump';
  execSync(`"${pgDump}" "${databaseUrl}" -f "${path}"`, {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  return path;
}

// ── 4. Apply in one transaction ───────────────────────────────────────────────

async function applyChanges(changes: Change[]): Promise<void> {
  await db.$transaction(async (tx) => {
    for (const change of changes) {
      if (change.kind === 'sale_item') {
        await tx.$executeRaw(
          Prisma.sql`UPDATE sale_items SET item_name = ${change.to} WHERE sale_id = ${change.saleId}::uuid AND menu_item_id = ${change.menuItemId}::uuid`,
        );
      } else {
        await tx.$executeRaw(
          Prisma.sql`UPDATE ${Prisma.raw(change.table)} SET ${Prisma.raw(change.sqlColumn)} = ${change.to} WHERE id = ${change.rowId}::uuid`,
        );
      }
    }
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  console.log('Scanning for DEMO- prefixes...\n');
  const changes = await collectChanges();

  if (changes.length === 0) {
    console.log('No rows with /demo/i matches found. Nothing to do.');
    process.exit(0);
  }

  // Print dry-run summary grouped by table
  const byTable = new Map<string, { label: string; from: string; to: string }[]>();
  for (const c of changes) {
    const table = c.kind === 'sale_item' ? 'sale_items' : c.table;
    const label =
      c.kind === 'sale_item'
        ? `${c.saleId.slice(0, 8)}/${c.menuItemId.slice(0, 8)} item_name`
        : `${c.rowId.slice(0, 8)} ${c.column}`;
    const list = byTable.get(table) ?? [];
    list.push({ label, from: c.from, to: c.to });
    byTable.set(table, list);
  }
  for (const [table, rows] of byTable) {
    console.log(`\n${table} (${rows.length} change${rows.length === 1 ? '' : 's'}):`);
    for (const r of rows) {
      console.log(`  [${r.label}]: "${r.from}" → "${r.to}"`);
    }
  }
  console.log(
    `\nTotal: ${changes.length} change${changes.length === 1 ? '' : 's'} across ${byTable.size} table${byTable.size === 1 ? '' : 's'}`,
  );

  if (!APPLY) {
    console.log('\nDry run complete. Pass --apply to execute.');
    process.exit(0);
  }

  // Check for collisions before backup
  console.log('\nChecking for unique-constraint collisions...');
  const collisions = await checkCollisions(changes);
  if (collisions.length > 0) {
    console.error('\nCollisions detected — aborting:');
    for (const e of collisions) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log('No collisions.');

  // Backup
  console.log('\nBacking up database...');
  let backupPath: string;
  try {
    backupPath = backup(config.DATABASE_URL);
    console.log(`Backup written to: ${backupPath}`);
  } catch (err) {
    console.error(`\nBackup failed — aborting: ${String(err)}`);
    process.exit(1);
  }

  // Apply
  console.log('\nApplying changes...');
  await applyChanges(changes);
  console.log('Done.');

  // Post-run audit
  console.log('\nRunning db:audit...\n');
  execSync('pnpm db:audit', { stdio: 'inherit', cwd: process.cwd() });
} finally {
  await db.$disconnect();
}
