import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import { InventoryController } from '@/modules/inventory/inventory.controller.js';
import { createInventoryRouter } from '@/modules/inventory/inventory.route.js';
import { InventoryService, type InventoryStore } from '@/modules/inventory/inventory.service.js';
import type { InventoryItem } from '@/modules/inventory/inventory.types.js';

const OUTLET = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const ITEM = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
const BASE = `/outlets/${OUTLET}/inventory`;
const ADJUST = `${BASE}/${ITEM}/adjust`;
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

function item(overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    outletId: OUTLET,
    menuItemId: ITEM,
    sku: 'BURGER-001',
    name: 'Burger',
    stockQuantity: 25,
    stockStatus: 'IN_STOCK',
    isActive: true,
    outletIsActive: true,
    menuItemIsActive: true,
    isEnabled: true,
    isSellable: true,
    updatedAt: new Date('2026-11-26T10:00:00Z'),
    ...overrides,
  };
}

const conflictError = (): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Write conflict', { code: 'P2034', clientVersion: '7' });

let store: Record<keyof InventoryStore, Mock>;
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
  const controller = new InventoryController(new InventoryService(store));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use(
    '/outlets/:outletId/inventory',
    createInventoryRouter(controller, fakeAuth, accessService),
  );
  instance.use(errorHandler);
  return instance;
}

const asAdmin = { 'x-test-user': 'admin' };
const asStaff = { 'x-test-user': 'staff' };
const okResult = (
  previous: number,
  next: number,
  operation = 'INCREASE',
): { kind: 'ok'; result: Record<string, unknown> } => ({
  kind: 'ok',
  result: {
    inventoryItem: item({ stockQuantity: next }),
    operation,
    previousStockQuantity: previous,
    newStockQuantity: next,
    changed: previous !== next,
  },
});

beforeEach(() => {
  access = { exists: true, member: true };
  store = {
    list: vi.fn(() => Promise.resolve({ items: [item()], total: 21 })),
    find: vi.fn(() => Promise.resolve(item())),
    adjust: vi.fn(() => Promise.resolve(okResult(50, 70))),
  };
});

describe('reading inventory', () => {
  it('scopes staff reads inside the query and lets HQ read everything', async () => {
    await request(app()).get(BASE).set(asStaff).expect(200);
    expect(store.list).toHaveBeenCalledWith(OUTLET, expect.anything(), {
      kind: 'member',
      userId: users.staff?.id,
    });
    await request(app())
      .get(
        `${BASE}?stockStatus=low&status=inactive&sortBy=stockQuantity&sortOrder=asc&search=%20bur%20`,
      )
      .set(asAdmin)
      .expect(200);
    expect(store.list).toHaveBeenLastCalledWith(
      OUTLET,
      {
        page: 1,
        limit: 20,
        search: 'bur',
        status: 'inactive',
        stockStatus: 'low',
        sortBy: 'stockQuantity',
        sortOrder: 'asc',
      },
      { kind: 'all' },
    );
  });

  it('returns pagination metadata', async () => {
    const response = await request(app()).get(`${BASE}?page=2&limit=10`).set(asAdmin).expect(200);
    expect(response.body.data.pagination).toEqual({ page: 2, limit: 10, total: 21, totalPages: 3 });
  });

  it('isolates outlets: 403 for staff without access, 404 for missing outlets or items', async () => {
    access.member = false;
    await request(app()).get(BASE).set(asStaff).expect(403);
    await request(app()).get(`${BASE}/${ITEM}`).set(asStaff).expect(403);
    expect(store.list).not.toHaveBeenCalled();
    access = { exists: false, member: true };
    await request(app()).get(BASE).set(asAdmin).expect(404);
    access.exists = true;
    store.find.mockResolvedValueOnce(null);
    await request(app()).get(`${BASE}/${ITEM}`).set(asStaff).expect(404);
  });

  it.each(['stockStatus=low_stock', 'sortBy=price', 'limit=0', 'unknown=1'])(
    'rejects %s',
    async (query) => {
      await request(app()).get(`${BASE}?${query}`).set(asAdmin).expect(400);
    },
  );

  it('validates both ids', async () => {
    await request(app()).get(`${BASE}/nope`).set(asAdmin).expect(400);
    await request(app()).get('/outlets/nope/inventory').set(asAdmin).expect(400);
  });
});

describe('adjusting stock', () => {
  it.each([
    { operation: 'INCREASE', quantity: 20 },
    { operation: 'DECREASE', quantity: 15 },
    { operation: 'SET', quantity: 40, expectedStockQuantity: 50 },
    { operation: 'SET', quantity: 0, expectedStockQuantity: 0 },
    { operation: 'INCREASE', quantity: 2147483647 },
  ])('accepts %j and passes it through unchanged', async (body) => {
    const response = await request(app()).patch(ADJUST).set(asAdmin).send(body).expect(200);
    expect(store.adjust).toHaveBeenCalledWith(users.admin?.id, OUTLET, ITEM, body);
    expect(response.body.data).toMatchObject({ previousStockQuantity: 50, newStockQuantity: 70 });
  });

  it.each([
    { operation: 'INCREASE', quantity: '20' },
    { operation: 'INCREASE', quantity: 0 },
    { operation: 'INCREASE', quantity: -1 },
    { operation: 'INCREASE', quantity: 1.5 },
    { operation: 'INCREASE', quantity: 2147483648 },
    { operation: 'INCREASE' },
    { operation: 'DECREASE', quantity: 0 },
    { operation: 'INCREASE', quantity: 5, expectedStockQuantity: 5 },
    { operation: 'SET', quantity: 5 },
    { operation: 'SET', quantity: -1, expectedStockQuantity: 0 },
    { operation: 'SET', quantity: 5, expectedStockQuantity: 1.5 },
    { operation: 'SET', quantity: 5, expectedStockQuantity: '5' },
    { operation: 'increase', quantity: 5 },
    { operation: 'INCREASE', quantity: 5, resultingStock: 99 },
    { operation: 'INCREASE', quantity: 5, overridePrice: '1.00' },
    { quantity: 5 },
  ])('rejects %j', async (body) => {
    await request(app()).patch(ADJUST).set(asAdmin).send(body).expect(400);
    expect(store.adjust).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'outlet-inactive' }, 409, 'OUTLET_INACTIVE'],
    [{ kind: 'stale', currentStockQuantity: 48 }, 409, 'STOCK_CHANGED'],
    [{ kind: 'insufficient', currentStockQuantity: 3 }, 409, 'INSUFFICIENT_STOCK'],
    [{ kind: 'overflow', currentStockQuantity: 2147483647 }, 409, 'STOCK_LIMIT_EXCEEDED'],
    [{ kind: 'assignment-not-found' }, 404, 'NOT_FOUND'],
    [{ kind: 'outlet-not-found' }, 404, 'NOT_FOUND'],
    [{ kind: 'forbidden' }, 403, 'AUTHORIZATION_ERROR'],
  ] as const)('maps %j to %i %s', async (outcome, status, code) => {
    store.adjust.mockResolvedValueOnce(outcome);
    const response = await request(app())
      .patch(ADJUST)
      .set(asAdmin)
      .send({ operation: 'DECREASE', quantity: 5 })
      .expect(status);
    expect(response.body.code).toBe(code);
  });

  it('includes the current balance in stale and insufficient messages', async () => {
    store.adjust.mockResolvedValueOnce({ kind: 'stale', currentStockQuantity: 48 });
    const response = await request(app())
      .patch(ADJUST)
      .set(asAdmin)
      .send({ operation: 'SET', quantity: 40, expectedStockQuantity: 50 })
      .expect(409);
    expect(response.body.message).toContain('48');
  });

  it('retries once on a rolled-back transaction conflict, never more', async () => {
    store.adjust.mockRejectedValueOnce(conflictError());
    await request(app())
      .patch(ADJUST)
      .set(asAdmin)
      .send({ operation: 'INCREASE', quantity: 1 })
      .expect(200);
    expect(store.adjust).toHaveBeenCalledTimes(2);

    store.adjust.mockClear();
    store.adjust.mockRejectedValueOnce(conflictError()).mockRejectedValueOnce(conflictError());
    const response = await request(app())
      .patch(ADJUST)
      .set(asAdmin)
      .send({ operation: 'INCREASE', quantity: 1 })
      .expect(409);
    expect(response.body.code).toBe('CONCURRENT_UPDATE');
    expect(store.adjust).toHaveBeenCalledTimes(2);
  });

  it('does not retry other failures', async () => {
    store.adjust.mockRejectedValueOnce(new Error('connection lost'));
    await request(app())
      .patch(ADJUST)
      .set(asAdmin)
      .send({ operation: 'INCREASE', quantity: 1 })
      .expect(500);
    expect(store.adjust).toHaveBeenCalledTimes(1);
  });

  it('is HQ-only', async () => {
    await request(app())
      .patch(ADJUST)
      .set(asStaff)
      .send({ operation: 'INCREASE', quantity: 1 })
      .expect(403);
    await request(app()).patch(ADJUST).send({ operation: 'INCREASE', quantity: 1 }).expect(401);
    expect(store.adjust).not.toHaveBeenCalled();
  });
});
