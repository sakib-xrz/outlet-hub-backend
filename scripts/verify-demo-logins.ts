import '@/config/load-env.js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { z } from 'zod';
import { createApp } from '@/app.js';
import { loadConfig } from '@/config/env.js';
import { createLogger } from '@/config/logger.js';
import { createPrismaClient } from '@/database/client.js';

const file = process.env.DEMO_CREDENTIALS_FILE;
if (!file)
  throw new Error(
    'Set DEMO_CREDENTIALS_FILE to the private credentials file written by db:seed:demo.',
  );
const credentials = z
  .array(z.object({ email: z.email(), password: z.string().min(12), outlets: z.array(z.string()) }))
  .parse(JSON.parse(readFileSync(file, 'utf8')));

const config = loadConfig({ ...process.env, LOG_LEVEL: 'silent', LOG_PRETTY: 'false' });
const db = createPrismaClient({ ...config, DATABASE_POOL_MAX: 3 });
const app = createApp({ config, database: db, logger: createLogger(config) });
const ORIGIN = config.ALLOWED_ORIGINS[0] ?? '';
const API = '/api/v1';
const SMOKE_REQUEST_ID = (() => {
  const hex = createHash('sha256').update('outlethub-demo:smoke-sale:staff.mirpur:1').digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
})();

type Row = { email: string; outlets: string; login: boolean; checks: string };
const rows: Row[] = [];
let failures = 0;

async function main(): Promise<void> {
  const outlets = await db.outlet.findMany({
    where: { code: { startsWith: 'DEMO-' } },
    select: { id: true, code: true, name: true, isActive: true },
  });
  const byKey = new Map(outlets.map((outlet) => [outlet.code.replace('DEMO-', ''), outlet]));

  for (const account of credentials) {
    const problems: string[] = [];
    const agent = request.agent(app);
    const login = await agent
      .post(`${API}/auth/login`)
      .set('Origin', ORIGIN)
      .send({ email: account.email, password: account.password });
    const token = (login.body as { data?: { accessToken?: string; user?: { role?: string } } })
      .data;
    if (login.status !== 200 || !token?.accessToken) {
      failures += 1;
      rows.push({
        email: account.email,
        outlets: account.outlets.join(', '),
        login: false,
        checks: `login ${login.status}`,
      });
      continue;
    }
    const auth = { Authorization: `Bearer ${token.accessToken}` };
    if (token.user?.role !== 'OUTLET_STAFF') problems.push(`role ${String(token.user?.role)}`);

    const list = await agent.get(`${API}/outlets`).query({ limit: 100 }).set(auth);
    const visible = ((list.body as { data?: { items?: { code: string }[] } }).data?.items ?? [])
      .map((outlet) => outlet.code.replace('DEMO-', ''))
      .sort();
    if (visible.join() !== [...account.outlets].sort().join()) {
      problems.push(`outlet list ${visible.join('/')}`);
    }
    for (const key of account.outlets) {
      const outlet = byKey.get(key);
      if (!outlet) continue;
      const detail = await agent.get(`${API}/outlets/${outlet.id}`).set(auth);
      const menu = await agent
        .get(`${API}/outlets/${outlet.id}/menu-items`)
        .query({ status: 'active', limit: 100 })
        .set(auth);
      const items =
        (menu.body as { data?: { items?: { isSellable: boolean }[] } }).data?.items ?? [];
      if (detail.status !== 200) problems.push(`${key} details ${detail.status}`);
      if (menu.status !== 200 || items.length === 0)
        problems.push(`${key} menu ${menu.status}/${items.length}`);
    }
    for (const outlet of outlets) {
      const key = outlet.code.replace('DEMO-', '');
      if (account.outlets.includes(key)) continue;
      const denied = await agent.get(`${API}/outlets/${outlet.id}/menu-items`).set(auth);
      if (denied.status !== 403) problems.push(`${key} not refused (${denied.status})`);
    }
    for (const path of ['/reports/summary', '/staff', '/menu-items']) {
      const denied = await agent.get(`${API}${path}`).set(auth);
      if (denied.status !== 403) problems.push(`${path} ${denied.status}`);
    }
    await agent.post(`${API}/auth/logout`).set('Origin', ORIGIN);
    if (problems.length) failures += 1;
    rows.push({
      email: account.email,
      outlets: account.outlets.join(', '),
      login: true,
      checks: problems.length
        ? problems.join('; ')
        : 'role, assigned outlets + menus, unassigned 403, HQ-only 403',
    });
  }

  const mirpur = byKey.get('MIRPUR');
  const cashier = credentials.find((account) => account.email === 'staff.mirpur@example.com');
  if (mirpur && cashier) {
    const agent = request.agent(app);
    const login = await agent
      .post(`${API}/auth/login`)
      .set('Origin', ORIGIN)
      .send({ email: cashier.email, password: cashier.password });
    const auth = {
      Authorization: `Bearer ${(login.body as { data: { accessToken: string } }).data.accessToken}`,
    };
    const existing = await agent
      .get(`${API}/outlets/${mirpur.id}/sales/by-request/${SMOKE_REQUEST_ID}`)
      .set(auth);
    if (existing.status === 200) {
      const sale = (
        existing.body as { data: { sale: { receiptCode: string; totalAmount: string } } }
      ).data.sale;
      process.stdout.write(
        `Smoke sale already recorded earlier: ${sale.receiptCode} ৳${sale.totalAmount} (request ${SMOKE_REQUEST_ID})\n`,
      );
    } else {
      const menu = await agent
        .get(`${API}/outlets/${mirpur.id}/menu-items`)
        .query({ status: 'active', limit: 100, sortBy: 'sku', sortOrder: 'asc' })
        .set(auth);
      const items = (
        menu.body as {
          data: {
            items: {
              menuItemId: string;
              sku: string;
              effectivePrice: string;
              stockQuantity: number;
              isSellable: boolean;
            }[];
          };
        }
      ).data.items
        .filter(
          (item) => item.isSellable && item.stockQuantity >= 5 && item.effectivePrice !== '0.00',
        )
        .slice(0, 2);
      const before = await db.outletMenuItem.findMany({
        where: { outletId: mirpur.id, menuItemId: { in: items.map((item) => item.menuItemId) } },
        select: { menuItemId: true, stockQuantity: true },
      });
      const counterBefore = (
        await db.receiptCounter.findUniqueOrThrow({ where: { outletId: mirpur.id } })
      ).lastNumber;
      const sale = await agent
        .post(`${API}/outlets/${mirpur.id}/sales`)
        .set(auth)
        .send({
          requestId: SMOKE_REQUEST_ID,
          items: items.map((item, index) => ({
            menuItemId: item.menuItemId,
            quantity: index + 1,
            expectedUnitPrice: item.effectivePrice,
          })),
        });
      const created = (
        sale.body as {
          data?: {
            sale?: { id: string; receiptNumber: number; receiptCode: string; totalAmount: string };
          };
        }
      ).data?.sale;
      const after = await db.outletMenuItem.findMany({
        where: { outletId: mirpur.id, menuItemId: { in: items.map((item) => item.menuItemId) } },
        select: { menuItemId: true, stockQuantity: true },
      });
      const counterAfter = (
        await db.receiptCounter.findUniqueOrThrow({ where: { outletId: mirpur.id } })
      ).lastNumber;
      const deducted = items.every((item, index) => {
        const was = before.find((row) => row.menuItemId === item.menuItemId)?.stockQuantity ?? 0;
        const now = after.find((row) => row.menuItemId === item.menuItemId)?.stockQuantity ?? 0;
        return was - now === index + 1;
      });
      const stored = created
        ? await db.sale.findUnique({ where: { id: created.id }, include: { items: true } })
        : null;
      const ok =
        sale.status === 201 &&
        deducted &&
        counterAfter === counterBefore + 1 &&
        created?.receiptNumber === counterAfter &&
        stored?.items.length === items.length &&
        stored.totalAmount.toFixed(2) === created.totalAmount;
      if (!ok) failures += 1;
      process.stdout.write(
        `${ok ? 'PASS' : 'FAIL'}  smoke sale by ${cashier.email}: ${created?.receiptCode ?? sale.status} ৳${created?.totalAmount ?? '?'}; stock deducted ${String(deducted)}; counter ${counterBefore} → ${counterAfter} (request ${SMOKE_REQUEST_ID})\n`,
      );
    }
    await agent.post(`${API}/auth/logout`).set('Origin', ORIGIN);
  }

  process.stdout.write(
    '\n| Email | Assigned outlets | Login verified | Checks |\n|---|---|---|---|\n',
  );
  for (const row of rows) {
    process.stdout.write(
      `| ${row.email} | ${row.outlets} | ${row.login ? 'yes' : 'NO'} | ${row.checks} |\n`,
    );
  }
  process.exitCode = failures ? 1 : 0;
}

try {
  await main();
} finally {
  await db.$disconnect();
}
