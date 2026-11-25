import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { MenuItemController } from '@/modules/menu-items/menu-item.controller.js';
import { createMenuItemRouter } from '@/modules/menu-items/menu-item.route.js';
import { MenuItemService, type MenuItemStore } from '@/modules/menu-items/menu-item.service.js';
import type { MenuItem } from '@/modules/menu-items/menu-item.types.js';

const ITEM_ID = '7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';
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

function item(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: ITEM_ID,
    sku: 'COFFEE-001',
    name: 'Cappuccino',
    description: null,
    basePrice: '180.00',
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error', { code, clientVersion: '7' });

let store: Record<keyof MenuItemStore, Mock>;

function app(): express.Express {
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    const user = users[req.header('x-test-user') ?? ''];
    if (user) req.user = user;
    next();
  };
  const controller = new MenuItemController(new MenuItemService(store));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use('/menu-items', createMenuItemRouter(controller, fakeAuth));
  instance.use(errorHandler);
  return instance;
}

const asAdmin = { 'x-test-user': 'admin' };
const valid = { sku: 'COFFEE-001', name: 'Cappuccino', basePrice: '180.00' };

beforeEach(() => {
  store = {
    list: vi.fn(() => Promise.resolve({ items: [item()], total: 41 })),
    findById: vi.fn(() => Promise.resolve(item())),
    create: vi.fn((input: Partial<MenuItem>) => Promise.resolve(item(input))),
    update: vi.fn((_id: string, input: Partial<MenuItem>) => Promise.resolve(item(input))),
    setActive: vi.fn((_id: string, isActive: boolean) => Promise.resolve(item({ isActive }))),
  };
});

describe('menu item authorization', () => {
  it.each([
    ['get', '/menu-items'],
    ['get', `/menu-items/${ITEM_ID}`],
    ['post', '/menu-items'],
    ['patch', `/menu-items/${ITEM_ID}`],
    ['patch', `/menu-items/${ITEM_ID}/status`],
  ] as const)('%s %s is HQ_ADMIN only', async (method, path) => {
    await request(app())[method](path).expect(401);
    await request(app())[method](path).set('x-test-user', 'staff').expect(403);
    expect(Object.values(store).every((fn) => fn.mock.calls.length === 0)).toBe(true);
  });
});

describe('POST /menu-items', () => {
  it('normalizes SKU, text and price, and returns 201 with a decimal string', async () => {
    const response = await request(app())
      .post('/menu-items')
      .set(asAdmin)
      .send({ sku: ' coffee-001 ', name: ' Cappuccino ', description: '  ', basePrice: '180.5' })
      .expect(201);
    expect(store.create).toHaveBeenCalledWith({
      sku: 'COFFEE-001',
      name: 'Cappuccino',
      description: null,
      basePrice: '180.50',
    });
    expect(response.body.data.menuItem.basePrice).toBe('180.50');
  });

  it.each(['0', '0.00', '9999999999.99'])('accepts boundary price %s', async (basePrice) => {
    await request(app())
      .post('/menu-items')
      .set(asAdmin)
      .send({ ...valid, basePrice })
      .expect(201);
  });

  it.each([
    ['basePrice', 180],
    ['basePrice', '-1.00'],
    ['basePrice', '1.005'],
    ['basePrice', 'NaN'],
    ['basePrice', 'Infinity'],
    ['basePrice', '1e2'],
    ['basePrice', '10000000000.00'],
    ['basePrice', null],
    ['sku', 'BAD SKU'],
    ['sku', 'DOUBLE--HYPHEN'],
    ['sku', 'X'.repeat(51)],
    ['name', '   '],
    ['name', 'x'.repeat(151)],
    ['description', 'x'.repeat(1001)],
    ['isActive', false],
    ['id', ITEM_ID],
  ] as [string, unknown][])('rejects %s = %j', async (field, value) => {
    await request(app())
      .post('/menu-items')
      .set(asAdmin)
      .send({ ...valid, [field]: value })
      .expect(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('maps duplicate SKUs to 409 on body.sku', async () => {
    store.create.mockRejectedValueOnce(prismaError('P2002'));
    const response = await request(app()).post('/menu-items').set(asAdmin).send(valid).expect(409);
    expect(response.body.errors).toEqual([
      { field: 'body.sku', message: 'This SKU is already in use' },
    ]);
  });
});

describe('PATCH /menu-items/:menuItemId', () => {
  it('applies partial updates including clearing the description and changing the price', async () => {
    await request(app())
      .patch(`/menu-items/${ITEM_ID}`)
      .set(asAdmin)
      .send({ description: null, basePrice: '200' })
      .expect(200);
    expect(store.update).toHaveBeenCalledWith(ITEM_ID, { description: null, basePrice: '200.00' });
  });

  it.each([
    {},
    { sku: 'NEW-1' },
    { isActive: false },
    { name: 'x', updatedAt: 'now' },
    { basePrice: 200 },
  ])('rejects %j', async (body) => {
    await request(app()).patch(`/menu-items/${ITEM_ID}`).set(asAdmin).send(body).expect(400);
    expect(store.update).not.toHaveBeenCalled();
  });

  it('returns 404 for a missing item and 400 for a malformed id', async () => {
    store.update.mockRejectedValueOnce(prismaError('P2025'));
    await request(app())
      .patch(`/menu-items/${ITEM_ID}`)
      .set(asAdmin)
      .send({ name: 'x' })
      .expect(404);
    await request(app()).patch('/menu-items/abc').set(asAdmin).send({ name: 'x' }).expect(400);
  });
});

describe('PATCH /menu-items/:menuItemId/status', () => {
  it('sets the status and returns the item', async () => {
    const response = await request(app())
      .patch(`/menu-items/${ITEM_ID}/status`)
      .set(asAdmin)
      .send({ isActive: false })
      .expect(200);
    expect(store.setActive).toHaveBeenCalledWith(ITEM_ID, false);
    expect(response.body.data.menuItem.isActive).toBe(false);
  });

  it('requires a strict boolean and an existing item', async () => {
    await request(app())
      .patch(`/menu-items/${ITEM_ID}/status`)
      .set(asAdmin)
      .send({ isActive: 'no' })
      .expect(400);
    store.setActive.mockResolvedValueOnce(null);
    await request(app())
      .patch(`/menu-items/${ITEM_ID}/status`)
      .set(asAdmin)
      .send({ isActive: true })
      .expect(404);
  });
});

describe('GET /menu-items', () => {
  it('validates and forwards filters and returns pagination', async () => {
    const response = await request(app())
      .get(
        '/menu-items?page=2&limit=10&search=%20cof%20&status=active&sortBy=basePrice&sortOrder=asc',
      )
      .set(asAdmin)
      .expect(200);
    expect(store.list).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      search: 'cof',
      status: 'active',
      sortBy: 'basePrice',
      sortOrder: 'asc',
    });
    expect(response.body.data.pagination).toEqual({ page: 2, limit: 10, total: 41, totalPages: 5 });
  });

  it.each(['limit=101', 'sortBy=description', 'status=deleted', 'outletId=x'])(
    'rejects %s',
    async (query) => {
      await request(app()).get(`/menu-items?${query}`).set(asAdmin).expect(400);
    },
  );
});

describe('GET /menu-items/:menuItemId', () => {
  it('returns the item or 404', async () => {
    const response = await request(app()).get(`/menu-items/${ITEM_ID}`).set(asAdmin).expect(200);
    expect(response.body.data.menuItem).toMatchObject({ sku: 'COFFEE-001', basePrice: '180.00' });
    store.findById.mockResolvedValueOnce(null);
    await request(app()).get(`/menu-items/${ITEM_ID}`).set(asAdmin).expect(404);
  });
});
