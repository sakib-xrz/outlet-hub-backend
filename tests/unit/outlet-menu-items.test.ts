import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import { OutletMenuItemController } from '@/modules/outlet-menu-items/outlet-menu-item.controller.js';
import { createOutletMenuItemRouter } from '@/modules/outlet-menu-items/outlet-menu-item.route.js';
import {
  OutletMenuItemService,
  type OutletMenuItemStore,
} from '@/modules/outlet-menu-items/outlet-menu-item.service.js';
import type { OutletMenuItem } from '@/modules/outlet-menu-items/outlet-menu-item.types.js';

const OUTLET = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const ITEM = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const BASE = `/outlets/${OUTLET}/menu-items`;
const users: Record<string, AuthenticatedUser> = {
  admin: {
    id: '1d6eaebf-c25a-4018-ac74-16d4df395294',
    email: 'a@example.com',
    role: Role.HQ_ADMIN,
  },
  staff: {
    id: '2e7fbfc0-d36b-4129-bd85-27e5e04a63a5',
    email: 's@example.com',
    role: Role.OUTLET_STAFF,
  },
};

function assignment(overrides: Partial<OutletMenuItem> = {}): OutletMenuItem {
  return {
    outletId: OUTLET,
    menuItemId: ITEM,
    sku: 'BURGER-001',
    name: 'Burger',
    description: null,
    basePrice: '250.00',
    overridePrice: null,
    effectivePrice: '250.00',
    priceSource: 'BASE',
    stockQuantity: 0,
    isActive: true,
    outletIsActive: true,
    menuItemIsActive: true,
    isEnabled: true,
    isSellable: false,
    createdAt: new Date('2026-11-26T10:00:00Z'),
    updatedAt: new Date('2026-11-26T10:00:00Z'),
    ...overrides,
  };
}

let store: Record<keyof OutletMenuItemStore, Mock>;
let access: { exists: boolean; member: boolean };

function app(): express.Express {
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    const user = users[req.header('x-test-user') ?? ''];
    if (user) req.user = user;
    next();
  };
  const accessService = new OutletAccessService({
    outletExists: () => Promise.resolve(access.exists),
    hasActiveMembership: () => Promise.resolve(access.member),
  });
  const controller = new OutletMenuItemController(new OutletMenuItemService(store));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use(
    '/outlets/:outletId/menu-items',
    createOutletMenuItemRouter(controller, fakeAuth, accessService),
  );
  instance.use(errorHandler);
  return instance;
}

const asAdmin = { 'x-test-user': 'admin' };
const asStaff = { 'x-test-user': 'staff' };

beforeEach(() => {
  access = { exists: true, member: true };
  store = {
    list: vi.fn(() => Promise.resolve({ items: [assignment()], total: 3 })),
    find: vi.fn(() => Promise.resolve(assignment())),
    assign: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    setOverridePrice: vi.fn(() => Promise.resolve({ kind: 'ok' })),
    setActive: vi.fn(() => Promise.resolve({ kind: 'ok' })),
  };
});

describe('reading an outlet menu', () => {
  it('scopes staff reads to their membership inside the query', async () => {
    await request(app()).get(BASE).set(asStaff).expect(200);
    expect(store.list).toHaveBeenCalledWith(OUTLET, expect.anything(), {
      kind: 'member',
      userId: users.staff?.id,
    });
    await request(app()).get(`${BASE}/${ITEM}`).set(asStaff).expect(200);
    expect(store.find).toHaveBeenCalledWith(OUTLET, ITEM, {
      kind: 'member',
      userId: users.staff?.id,
    });
  });

  it('lets HQ admins read every assignment', async () => {
    const response = await request(app())
      .get(`${BASE}?search=%20burg%20&status=inactive&sortBy=sku&sortOrder=desc&page=1&limit=2`)
      .set(asAdmin)
      .expect(200);
    expect(store.list).toHaveBeenCalledWith(
      OUTLET,
      { page: 1, limit: 2, search: 'burg', status: 'inactive', sortBy: 'sku', sortOrder: 'desc' },
      { kind: 'all' },
    );
    expect(response.body.data.pagination).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2 });
    expect(response.body.data.items[0]).toMatchObject({
      effectivePrice: '250.00',
      priceSource: 'BASE',
    });
  });

  it('keeps cross-outlet isolation: no access is 403 and never queries assignments', async () => {
    access.member = false;
    await request(app()).get(BASE).set(asStaff).expect(403);
    await request(app()).get(`${BASE}/${ITEM}`).set(asStaff).expect(403);
    expect(store.list).not.toHaveBeenCalled();
    expect(store.find).not.toHaveBeenCalled();
  });

  it('returns 404 for missing outlets (HQ) and for unassigned or disabled items', async () => {
    access.exists = false;
    await request(app()).get(BASE).set(asAdmin).expect(404);
    access.exists = true;
    store.find.mockResolvedValueOnce(null);
    await request(app()).get(`${BASE}/${ITEM}`).set(asStaff).expect(404);
  });

  it.each([
    'sortBy=effectivePrice',
    'sortBy=stockQuantity',
    'limit=101',
    'status=enabled',
    'outletId=x',
  ])('rejects %s', async (query) => {
    await request(app()).get(`${BASE}?${query}`).set(asAdmin).expect(400);
  });

  it('validates both ids', async () => {
    await request(app()).get('/outlets/not-a-uuid/menu-items').set(asAdmin).expect(400);
    await request(app()).get(`${BASE}/not-a-uuid`).set(asAdmin).expect(400);
  });
});

describe('POST /outlets/:outletId/menu-items', () => {
  it('assigns with inherited pricing by default and returns 201', async () => {
    const response = await request(app())
      .post(BASE)
      .set(asAdmin)
      .send({ menuItemId: ITEM })
      .expect(201);
    expect(store.assign).toHaveBeenCalledWith(users.admin?.id, OUTLET, ITEM, null);
    expect(response.body.data.outletMenuItem).toMatchObject({ stockQuantity: 0, isActive: true });
  });

  it('normalizes an explicit zero override', async () => {
    await request(app())
      .post(BASE)
      .set(asAdmin)
      .send({ menuItemId: ITEM, overridePrice: '0' })
      .expect(201);
    expect(store.assign).toHaveBeenCalledWith(users.admin?.id, OUTLET, ITEM, '0.00');
  });

  it.each([
    { menuItemId: ITEM, stockQuantity: 5 },
    { menuItemId: ITEM, isActive: false },
    { menuItemId: ITEM, effectivePrice: '1.00' },
    { menuItemId: ITEM, outletId: OUTLET },
    { menuItemId: ITEM, overridePrice: 280 },
    { menuItemId: ITEM, overridePrice: '-1' },
    { menuItemId: ITEM, overridePrice: '1.999' },
    { menuItemId: ITEM, overridePrice: 'NaN' },
    { menuItemId: ITEM, overridePrice: 'Infinity' },
    { menuItemId: ITEM, overridePrice: '2e2' },
    { menuItemId: ITEM, overridePrice: '10000000000.00' },
    { menuItemId: 'nope' },
    {},
  ])('rejects %j', async (body) => {
    await request(app()).post(BASE).set(asAdmin).send(body).expect(400);
    expect(store.assign).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'already-assigned', isActive: true }, 409, /already assigned/],
    [{ kind: 'already-assigned', isActive: false }, 409, /reactivate it instead/],
    [{ kind: 'outlet-inactive' }, 409, /outlet is inactive/],
    [{ kind: 'menu-item-inactive' }, 409, /master menu item is inactive/],
    [{ kind: 'menu-item-not-found' }, 400, /Validation failed/],
    [{ kind: 'outlet-not-found' }, 404, /Outlet not found/],
    [{ kind: 'forbidden' }, 403, /permission/],
  ] as const)('maps %j to %i', async (result, status, message) => {
    store.assign.mockResolvedValueOnce(result);
    const response = await request(app())
      .post(BASE)
      .set(asAdmin)
      .send({ menuItemId: ITEM })
      .expect(status);
    expect(response.body.message).toMatch(message);
  });

  it('maps a concurrent composite-key violation to 409', async () => {
    store.assign.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('Unique', { code: 'P2002', clientVersion: '7' }),
    );
    const response = await request(app())
      .post(BASE)
      .set(asAdmin)
      .send({ menuItemId: ITEM })
      .expect(409);
    expect(response.body.errors[0]).toMatchObject({ field: 'body.menuItemId' });
  });

  it('is HQ-only', async () => {
    await request(app()).post(BASE).set(asStaff).send({ menuItemId: ITEM }).expect(403);
    await request(app()).post(BASE).send({ menuItemId: ITEM }).expect(401);
  });
});

describe('PATCH .../price', () => {
  it.each([
    ['300', '300.00'],
    ['0', '0.00'],
    [null, null],
  ] as const)('stores %j as %j', async (input, stored) => {
    await request(app())
      .patch(`${BASE}/${ITEM}/price`)
      .set(asAdmin)
      .send({ overridePrice: input })
      .expect(200);
    expect(store.setOverridePrice).toHaveBeenCalledWith(users.admin?.id, OUTLET, ITEM, stored);
  });

  it.each([
    {},
    { overridePrice: 300 },
    { overridePrice: '1.234' },
    { overridePrice: null, stockQuantity: 1 },
  ])('rejects %j', async (body) => {
    await request(app()).patch(`${BASE}/${ITEM}/price`).set(asAdmin).send(body).expect(400);
  });

  it('returns 404 for unassigned items and 403 for staff', async () => {
    store.setOverridePrice.mockResolvedValueOnce({ kind: 'assignment-not-found' });
    await request(app())
      .patch(`${BASE}/${ITEM}/price`)
      .set(asAdmin)
      .send({ overridePrice: null })
      .expect(404);
    await request(app())
      .patch(`${BASE}/${ITEM}/price`)
      .set(asStaff)
      .send({ overridePrice: null })
      .expect(403);
  });
});

describe('PATCH .../status', () => {
  it('passes a strict boolean and returns the assignment', async () => {
    await request(app())
      .patch(`${BASE}/${ITEM}/status`)
      .set(asAdmin)
      .send({ isActive: false })
      .expect(200);
    expect(store.setActive).toHaveBeenCalledWith(users.admin?.id, OUTLET, ITEM, false);
    await request(app())
      .patch(`${BASE}/${ITEM}/status`)
      .set(asAdmin)
      .send({ isActive: 'false' })
      .expect(400);
  });

  it('refuses reactivation under an inactive parent with 409', async () => {
    store.setActive.mockResolvedValueOnce({ kind: 'menu-item-inactive' });
    await request(app())
      .patch(`${BASE}/${ITEM}/status`)
      .set(asAdmin)
      .send({ isActive: true })
      .expect(409);
    store.setActive.mockResolvedValueOnce({ kind: 'outlet-inactive' });
    await request(app())
      .patch(`${BASE}/${ITEM}/status`)
      .set(asAdmin)
      .send({ isActive: true })
      .expect(409);
  });
});
