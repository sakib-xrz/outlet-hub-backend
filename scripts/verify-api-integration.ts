import '@/config/load-env.js';
import { randomBytes, randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '@/app.js';
import { hashPassword } from '@/common/security/password.js';
import { loadConfig } from '@/config/env.js';
import { createLogger } from '@/config/logger.js';
import { Role } from '@/generated/prisma/enums.js';
import {
  connectDisposableDatabase,
  FIXTURE_CODE_PREFIX,
  FIXTURE_EMAIL_DOMAIN,
} from './support/disposable-database.js';

const VARIABLE = 'API_VERIFICATION_DATABASE_URL';
const db = await connectDisposableDatabase(VARIABLE);
const ORIGIN = 'http://localhost:5173';
const config = loadConfig({
  ...process.env,
  NODE_ENV: 'development',
  DATABASE_URL: process.env[VARIABLE],
  JWT_SECRET: randomBytes(48).toString('hex'),
  ALLOWED_ORIGINS: ORIGIN,
  COOKIE_SECURE: 'false',
  COOKIE_SAME_SITE: 'strict',
  GLOBAL_RATE_LIMIT_MAX: '100000',
  AUTH_RATE_LIMIT_MAX: '1000',
  LOG_LEVEL: 'silent',
  LOG_PRETTY: 'false',
  SWAGGER_ENABLED: 'false',
});
const app = createApp({ config, database: db, logger: createLogger(config) });

const results: { check: string; passed: boolean; detail: string }[] = [];
function check(name: string, passed: boolean, detail: unknown = null): void {
  results.push({ check: name, passed, detail: passed ? '' : JSON.stringify(detail) });
}

type Body = { success: boolean; code?: string; data?: any; errors?: { meta?: any }[] };
type Agent = ReturnType<typeof request.agent>;
const API = '/api/v1';
const tag = randomUUID().slice(0, 6).toUpperCase();
const password = (): string => `${randomBytes(18).toString('base64url')}!a1`;

async function login(agent: Agent, email: string, secret: string): Promise<string> {
  const response = await agent
    .post(`${API}/auth/login`)
    .set('Origin', ORIGIN)
    .send({ email, password: secret });
  if (response.status !== 200)
    throw new Error(`Login failed for fixture account: ${response.status}`);
  return (response.body as Body).data.accessToken as string;
}

type Pending = ReturnType<Agent['get']>;
type Caller = {
  get: (path: string, query?: Record<string, string | number>) => Pending;
  post: (path: string, body: unknown) => Pending;
  patch: (path: string, body: unknown) => Pending;
  put: (path: string, body: unknown) => Pending;
};

const call = (agent: Agent, token: string | null): Caller => ({
  get: (path: string, query?: Record<string, string | number>) => {
    const pending = agent.get(`${API}${path}`).query(query ?? {});
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  },
  post: (path: string, body: unknown) => {
    const pending = agent.post(`${API}${path}`).send(body as object);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  },
  patch: (path: string, body: unknown) => {
    const pending = agent.patch(`${API}${path}`).send(body as object);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  },
  put: (path: string, body: unknown) => {
    const pending = agent.put(`${API}${path}`).send(body as object);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  },
});

const stockOf = async (outletId: string, menuItemId: string): Promise<number> =>
  (
    await db.outletMenuItem.findUniqueOrThrow({
      where: { outletId_menuItemId: { outletId, menuItemId } },
    })
  ).stockQuantity;
const counterOf = async (outletId: string): Promise<number> =>
  (await db.receiptCounter.findUniqueOrThrow({ where: { outletId } })).lastNumber;

async function main(): Promise<void> {
  const instant = new Date('2026-01-01T00:00:00.000Z');
  const [zone] = await db.$queryRaw<{ tz: string; utc: string }[]>`
    SELECT current_setting('TimeZone') AS tz,
           to_char(${instant}::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS utc`;
  check(
    'sessions run in UTC so Date parameters keep their instant',
    zone?.tz === 'UTC' && zone.utc === '2026-01-01T00:00:00',
    zone,
  );
  const adminEmail = `verify-admin-${tag.toLowerCase()}${FIXTURE_EMAIL_DOMAIN}`;
  const adminPassword = password();
  await db.user.create({
    data: {
      email: adminEmail,
      passwordHash: await hashPassword(adminPassword),
      role: Role.HQ_ADMIN,
    },
  });
  const stored = await db.user.findUniqueOrThrow({ where: { email: adminEmail } });
  check('admin password is stored as Argon2id', stored.passwordHash.startsWith('$argon2id$'));

  const anonymous = request.agent(app);
  const wrong = await anonymous
    .post(`${API}/auth/login`)
    .set('Origin', ORIGIN)
    .send({ email: adminEmail, password: 'wrong-password-123' });
  check('invalid credentials are rejected with 401', wrong.status === 401, wrong.body);
  const unknown = await anonymous
    .post(`${API}/auth/login`)
    .set('Origin', ORIGIN)
    .send({ email: `nobody-${tag}${FIXTURE_EMAIL_DOMAIN}`, password: 'whatever-123' });
  check(
    'unknown accounts get the same 401',
    unknown.status === 401 && (unknown.body as Body).code === (wrong.body as Body).code,
    unknown.body,
  );
  const noAuth = await anonymous.get(`${API}/outlets`);
  check('unauthenticated requests get 401', noAuth.status === 401, noAuth.status);

  const hqAgent = request.agent(app);
  const hqToken = await login(hqAgent, adminEmail, adminPassword);
  const hq = call(hqAgent, hqToken);
  const me = await hq.get('/auth/me');
  check('HQ /auth/me returns HQ_ADMIN', me.body.data?.user?.role === 'HQ_ADMIN', me.body);

  const now = Date.now();
  const range = {
    from: new Date(now - 3_600_000).toISOString(),
    to: new Date(now + 3_600_000).toISOString(),
  };
  const baseline = (await hq.get('/reports/summary', range)).body.data as Record<string, string>;
  const cents = (value: string | undefined): bigint => BigInt((value ?? '0').replace('.', ''));

  const createOutlet = async (suffix: string): Promise<string> => {
    const response = await hq.post('/outlets', {
      code: `${FIXTURE_CODE_PREFIX}API${tag}${suffix}`,
      name: `API outlet ${suffix}`,
      address: 'House 12, Road 7, Dhaka',
    });
    check(`outlet ${suffix} is created (201)`, response.status === 201, response.body);
    return (response.body as Body).data.outlet.id as string;
  };
  const outletA = await createOutlet('A');
  const outletB = await createOutlet('B');
  check('receipt counter starts at 0', (await counterOf(outletA)) === 0);

  const staffEmail = `verify-staff-${tag.toLowerCase()}${FIXTURE_EMAIL_DOMAIN}`;
  const staffPassword = password();
  const staffResponse = await hq.post('/staff', {
    email: staffEmail,
    password: staffPassword,
    outletIds: [],
  });
  check('staff account is created (201)', staffResponse.status === 201, staffResponse.body);
  const staffId = (staffResponse.body as Body).data.staff.id as string;
  const assignment = await hq.put(`/staff/${staffId}/outlets`, { outletIds: [outletA] });
  check('staff is assigned to outlet A', assignment.status === 200, assignment.body);
  const staffRow = await db.user.findUniqueOrThrow({ where: { id: staffId } });
  check(
    'staff password is stored as Argon2id',
    staffRow.passwordHash.startsWith('$argon2id$') && staffRow.role === 'OUTLET_STAFF',
  );

  const createItem = async (sku: string, name: string, basePrice: string): Promise<string> => {
    const response = await hq.post('/menu-items', {
      sku: `${FIXTURE_CODE_PREFIX}${tag}-${sku}`,
      name,
      description: `${name} for API verification`,
      basePrice,
    });
    check(
      `menu item ${sku} is created`,
      response.status === 201 && response.body.data.menuItem.basePrice === basePrice,
      response.body,
    );
    return (response.body as Body).data.menuItem.id as string;
  };
  const burger = await createItem('BURGER', 'Beef Burger', '250.00');
  const fries = await createItem('FRIES', 'Masala Fries', '120.50');
  const tea = await createItem('TEA', 'Milk Tea', '30.00');

  for (const item of [burger, fries, tea]) {
    const response = await hq.post(`/outlets/${outletA}/menu-items`, { menuItemId: item });
    check('item is assigned to outlet A', response.status === 201, response.body);
  }
  await hq.post(`/outlets/${outletB}/menu-items`, { menuItemId: burger });
  const override = await hq.patch(`/outlets/${outletA}/menu-items/${burger}/price`, {
    overridePrice: '260',
  });
  check(
    'override price is normalized and becomes the effective price',
    override.body.data?.outletMenuItem?.overridePrice === '260.00' &&
      override.body.data?.outletMenuItem?.effectivePrice === '260.00',
    override.body,
  );
  const teaOverride = await hq.patch(`/outlets/${outletA}/menu-items/${tea}/price`, {
    overridePrice: '25.75',
  });
  check(
    'second override is stored exactly',
    teaOverride.body.data?.outletMenuItem?.effectivePrice === '25.75',
    teaOverride.body,
  );

  for (const [item, quantity] of [
    [burger, 20],
    [fries, 5],
    [tea, 20],
  ] as const) {
    const response = await hq.patch(`/outlets/${outletA}/inventory/${item}/adjust`, {
      operation: 'INCREASE',
      quantity,
    });
    check(
      `stock replenished by ${quantity}`,
      response.status === 200 && response.body.data.newStockQuantity === quantity,
      response.body,
    );
  }
  const negative = await hq.patch(`/outlets/${outletA}/inventory/${fries}/adjust`, {
    operation: 'DECREASE',
    quantity: 6,
  });
  check(
    'stock adjustment cannot go negative',
    negative.status === 409 && (await stockOf(outletA, fries)) === 5,
    negative.body,
  );

  const staffAgent = request.agent(app);
  const staffLogin = await staffAgent
    .post(`${API}/auth/login`)
    .set('Origin', ORIGIN)
    .send({ email: staffEmail, password: staffPassword });
  check(
    'staff logs in with real credentials',
    staffLogin.status === 200 && staffLogin.body.data?.user?.role === 'OUTLET_STAFF',
    staffLogin.status,
  );
  const staffToken = staffLogin.body.data.accessToken as string;
  const staffLoginCookie = ([] as string[])
    .concat((staffLogin.headers['set-cookie'] as unknown as string[] | undefined) ?? [])
    .find((cookie) => cookie.startsWith(`${config.REFRESH_COOKIE_NAME}=`))
    ?.split(';')[0];
  const staff = call(staffAgent, staffToken);
  const staffMe = await staff.get('/auth/me');
  check(
    'staff /auth/me returns OUTLET_STAFF',
    staffMe.body.data?.user?.role === 'OUTLET_STAFF',
    staffMe.body,
  );
  const menu = await staff.get(`/outlets/${outletA}/menu-items`, { status: 'active', limit: 100 });
  const prices = Object.fromEntries(
    (menu.body.data?.items ?? []).map((row: any) => [row.menuItemId, row.effectivePrice]),
  );
  check(
    'staff sees the assigned menu with effective prices',
    prices[burger] === '260.00' && prices[fries] === '120.50' && prices[tea] === '25.75',
    menu.body,
  );
  for (const [label, response] of [
    ['outlet B menu', await staff.get(`/outlets/${outletB}/menu-items`)],
    ['outlet B details', await staff.get(`/outlets/${outletB}`)],
    ['outlet B sales', await staff.get(`/outlets/${outletB}/sales`)],
    ['outlet B inventory', await staff.get(`/outlets/${outletB}/inventory`)],
  ] as const) {
    check(`staff is refused ${label} (403)`, response.status === 403, response.status);
  }
  for (const [label, response] of [
    ['reports summary', await staff.get('/reports/summary')],
    ['staff list', await staff.get('/staff')],
    ['outlet creation', await staff.post('/outlets', { code: `X${tag}`, name: 'Nope' })],
    [
      'menu item creation',
      await staff.post('/menu-items', { sku: `X${tag}`, name: 'Nope', basePrice: '1.00' }),
    ],
    [
      'stock adjustment',
      await staff.patch(`/outlets/${outletA}/inventory/${burger}/adjust`, {
        operation: 'INCREASE',
        quantity: 1,
      }),
    ],
  ] as const) {
    check(`staff is refused HQ-only ${label} (403)`, response.status === 403, response.status);
  }

  const requestId = randomUUID();
  const saleBody = {
    requestId,
    items: [
      { menuItemId: burger, quantity: 2, expectedUnitPrice: '260.00' },
      { menuItemId: fries, quantity: 3, expectedUnitPrice: '120.50' },
      { menuItemId: tea, quantity: 4, expectedUnitPrice: '25.75' },
    ],
  };
  const created = await staff.post(`/outlets/${outletA}/sales`, saleBody);
  const sale = created.body.data?.sale;
  check(
    'multi-item sale returns 201',
    created.status === 201 && created.body.data?.replayed === false,
    created.body,
  );
  check(
    'sale total is exact (520.00 + 361.50 + 103.00)',
    sale?.totalAmount === '984.50',
    sale?.totalAmount,
  );
  check(
    'line totals are exact',
    JSON.stringify(
      sale?.items.map((line: any) => [line.quantity, line.unitPrice, line.lineTotal]).sort(),
    ) ===
      JSON.stringify(
        [
          [2, '260.00', '520.00'],
          [3, '120.50', '361.50'],
          [4, '25.75', '103.00'],
        ].sort(),
      ),
    sale?.items,
  );
  check(
    'receipt number 1 and code',
    sale?.receiptNumber === 1 && sale?.receiptCode === `${FIXTURE_CODE_PREFIX}API${tag}A-000001`,
    sale,
  );
  check(
    'stock deducted (18, 2, 16)',
    (await stockOf(outletA, burger)) === 18 &&
      (await stockOf(outletA, fries)) === 2 &&
      (await stockOf(outletA, tea)) === 16,
  );
  check('counter is 1', (await counterOf(outletA)) === 1);

  const replay = await staff.post(`/outlets/${outletA}/sales`, saleBody);
  check(
    'replay returns 200 with the same sale',
    replay.status === 200 &&
      replay.body.data?.replayed === true &&
      replay.body.data?.sale?.id === sale?.id,
    replay.body,
  );
  check(
    'replay does not deduct stock again',
    (await stockOf(outletA, burger)) === 18 && (await stockOf(outletA, fries)) === 2,
  );
  check(
    'replay does not consume a receipt',
    (await counterOf(outletA)) === 1 &&
      (await db.sale.count({ where: { outletId: outletA } })) === 1,
  );
  const conflict = await staff.post(`/outlets/${outletA}/sales`, {
    ...saleBody,
    items: saleBody.items.slice(0, 1),
  });
  check(
    'same request id with another payload is IDEMPOTENCY_CONFLICT',
    conflict.status === 409 && conflict.body.code === 'IDEMPOTENCY_CONFLICT',
    conflict.body,
  );

  const second = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: tea, quantity: 1, expectedUnitPrice: '25.75' }],
  });
  check(
    'next sale gets receipt 2',
    second.status === 201 && second.body.data.sale.receiptNumber === 2,
    second.body,
  );

  const detail = await staff.get(`/outlets/${outletA}/sales/${sale?.id}`);
  check(
    'historical receipt is retrievable',
    detail.status === 200 && detail.body.data.sale.totalAmount === '984.50',
    detail.body,
  );
  const byRequest = await staff.get(`/outlets/${outletA}/sales/by-request/${requestId}`);
  check(
    'sale is retrievable by request id',
    byRequest.status === 200 && byRequest.body.data.sale.id === sale?.id,
    byRequest.body,
  );
  const history = await staff.get(`/outlets/${outletA}/sales`);
  check(
    'sales history lists both sales',
    history.body.data?.pagination?.total === 2,
    history.body.data?.pagination,
  );

  await db.menuItem.update({ where: { id: burger }, data: { name: 'Renamed Beef Burger' } });
  const snapshot = await staff.get(`/outlets/${outletA}/sales/${sale?.id}`);
  check(
    'receipt keeps the historical item name',
    snapshot.body.data.sale.items.some((line: any) => line.itemName === 'Beef Burger'),
    snapshot.body.data.sale.items,
  );

  const oversell = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: fries, quantity: 3, expectedUnitPrice: '120.50' }],
  });
  check(
    'overselling is INSUFFICIENT_STOCK with the available quantity',
    oversell.status === 409 &&
      oversell.body.code === 'INSUFFICIENT_STOCK' &&
      oversell.body.errors?.[0]?.meta?.availableQuantity === 2,
    oversell.body,
  );
  check(
    'refused sale leaves stock and counter',
    (await stockOf(outletA, fries)) === 2 && (await counterOf(outletA)) === 2,
  );

  const stale = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: burger, quantity: 1, expectedUnitPrice: '250.00' }],
  });
  check(
    'stale expected price is PRICE_CHANGED with the current price',
    stale.status === 409 &&
      stale.body.code === 'PRICE_CHANGED' &&
      stale.body.errors?.[0]?.meta?.currentUnitPrice === '260.00',
    stale.body,
  );

  const crossOutlet = await staff.post(`/outlets/${outletB}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: burger, quantity: 1, expectedUnitPrice: '250.00' }],
  });
  check(
    'staff cannot sell at an unassigned outlet (403)',
    crossOutlet.status === 403,
    crossOutlet.body,
  );
  const hqSale = await hq.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: tea, quantity: 1, expectedUnitPrice: '25.75' }],
  });
  check('HQ cannot ring up sales (403)', hqSale.status === 403, hqSale.body);
  const crossSale = await staff.get(`/outlets/${outletA}/sales/${randomUUID()}`);
  check('unknown sale id is 404', crossSale.status === 404, crossSale.status);

  await hq.patch(`/outlets/${outletA}/menu-items/${tea}/status`, { isActive: false });
  const disabled = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: tea, quantity: 1, expectedUnitPrice: '25.75' }],
  });
  check(
    'disabled assignment is ITEM_UNAVAILABLE',
    disabled.status === 409 && disabled.body.code === 'ITEM_UNAVAILABLE',
    disabled.body,
  );
  await hq.patch(`/menu-items/${fries}/status`, { isActive: false });
  const inactiveItem = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: fries, quantity: 1, expectedUnitPrice: '120.50' }],
  });
  check(
    'inactive master item is ITEM_UNAVAILABLE',
    inactiveItem.status === 409 && inactiveItem.body.code === 'ITEM_UNAVAILABLE',
    inactiveItem.body,
  );

  const summary = await hq.get('/reports/summary', range);
  check(
    'summary revenue and counts are exact (984.50 + 25.75)',
    cents(summary.body.data?.totalRevenue) - cents(baseline.totalRevenue) === 101_025n &&
      BigInt(summary.body.data?.totalSales ?? 0) - BigInt(baseline.totalSales ?? 0) === 2n &&
      BigInt(summary.body.data?.totalUnitsSold ?? 0) - BigInt(baseline.totalUnitsSold ?? 0) ===
        10n &&
      /^\d+\.\d{2}$/.test(summary.body.data?.totalRevenue ?? ''),
    { baseline, after: summary.body.data },
  );
  const byOutlet = await hq.get('/reports/revenue-by-outlet', { ...range, search: `API${tag}` });
  check(
    'revenue by outlet includes the zero-sale outlet',
    JSON.stringify(
      byOutlet.body.data?.items.map((row: any) => [row.outletId, row.totalRevenue, row.totalSales]),
    ) ===
      JSON.stringify([
        [outletA, '1010.25', '2'],
        [outletB, '0.00', '0'],
      ]),
    byOutlet.body.data,
  );
  const top = await hq.get(`/reports/outlets/${outletA}/top-selling-items`, range);
  check(
    'top-selling items rank by quantity with exact revenue and current labels',
    JSON.stringify(
      top.body.data?.items.map((row: any) => [
        row.rank,
        row.menuItemId,
        row.quantitySold,
        row.totalRevenue,
      ]),
    ) ===
      JSON.stringify([
        [1, tea, '5', '128.75'],
        [2, fries, '3', '361.50'],
        [3, burger, '2', '520.00'],
      ]) && top.body.data.items[2].name === 'Renamed Beef Burger',
    top.body.data,
  );
  const reportRange = await hq.get('/reports/summary', { from: range.to, to: range.from });
  check('reversed report range is 400', reportRange.status === 400, reportRange.body);

  await hq.patch(`/outlets/${outletA}/status`, { isActive: false });
  const inactiveOutlet = await staff.post(`/outlets/${outletA}/sales`, {
    requestId: randomUUID(),
    items: [{ menuItemId: burger, quantity: 1, expectedUnitPrice: '260.00' }],
  });
  check(
    'sales at an inactive outlet are refused',
    [403, 409].includes(inactiveOutlet.status) && (await counterOf(outletA)) === 2,
    { status: inactiveOutlet.status, code: inactiveOutlet.body.code },
  );
  const inactiveReport = await hq.get(`/reports/outlets/${outletA}/top-selling-items`);
  check(
    'inactive outlet stays reportable',
    inactiveReport.status === 200 && inactiveReport.body.data.outlet.isActive === false,
    inactiveReport.body,
  );

  const untrusted = await anonymous
    .post(`${API}/auth/login`)
    .set('Origin', 'https://evil.example')
    .send({ email: staffEmail, password: staffPassword });
  check('login from an untrusted Origin is refused', untrusted.status === 403, untrusted.status);
  const cookieValue = (response: { headers: Record<string, unknown> }): string | undefined =>
    ([] as string[])
      .concat((response.headers['set-cookie'] as string[] | undefined) ?? [])
      .find((cookie) => cookie.startsWith(`${config.REFRESH_COOKIE_NAME}=`))
      ?.split(';')[0];
  const noOrigin = await staffAgent.post(`${API}/auth/refresh`);
  check('refresh without a trusted Origin is refused', noOrigin.status === 403, noOrigin.status);
  const refreshed = await staffAgent.post(`${API}/auth/refresh`).set('Origin', ORIGIN);
  const newToken = refreshed.body.data?.accessToken as string | undefined;
  check(
    'refresh issues an access token and rotates the refresh cookie',
    refreshed.status === 200 && Boolean(newToken) && Boolean(cookieValue(refreshed)),
    refreshed.status,
  );
  const reuse = await request(app)
    .post(`${API}/auth/refresh`)
    .set('Origin', ORIGIN)
    .set('Cookie', staffLoginCookie ?? '');
  check('the rotated-out refresh token is rejected', reuse.status === 401, reuse.status);
  const meAfter = await staffAgent
    .get(`${API}/auth/me`)
    .set('Authorization', `Bearer ${newToken ?? ''}`);
  check('refreshed token authenticates', meAfter.status === 200, meAfter.status);
  const logout = await staffAgent.post(`${API}/auth/logout`).set('Origin', ORIGIN);
  check('logout succeeds', logout.status === 200, logout.status);
  const afterLogout = await staffAgent.post(`${API}/auth/refresh`).set('Origin', ORIGIN);
  check('refresh after logout is 401', afterLogout.status === 401, afterLogout.status);

  const deactivate = await hq.patch(`/staff/${staffId}/status`, { isActive: false });
  check('HQ can deactivate staff', deactivate.status === 200, deactivate.body);
  const relogin = await request(app)
    .post(`${API}/auth/login`)
    .set('Origin', ORIGIN)
    .send({ email: staffEmail, password: staffPassword });
  check('deactivated staff cannot log in', relogin.status === 401, relogin.status);
  const oldToken = await request(app)
    .get(`${API}/auth/me`)
    .set('Authorization', `Bearer ${newToken ?? ''}`);
  check('deactivated staff access token is rejected', oldToken.status === 401, oldToken.status);

  const failed = results.filter((result) => !result.passed);
  for (const result of results) {
    process.stdout.write(
      `${result.passed ? 'PASS' : 'FAIL'}  ${result.check}${result.detail ? `  ${result.detail}` : ''}\n`,
    );
  }
  process.stdout.write(`\n${results.length - failed.length}/${results.length} checks passed\n`);
  process.exitCode = failed.length ? 1 : 0;
}

try {
  await main();
} finally {
  await db.$disconnect();
}
