import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import { hashSaleRequest } from '@/modules/sales/sale-calculation.js';
import { SaleController } from '@/modules/sales/sale.controller.js';
import { createSaleRouter } from '@/modules/sales/sale.route.js';
import { SaleService, type SaleStore } from '@/modules/sales/sale.service.js';
import type { Sale } from '@/modules/sales/sale.types.js';

const OUTLET = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const ITEM_A = '11111111-1111-4111-8111-111111111111';
const ITEM_B = '22222222-2222-4222-8222-222222222222';
const SALE_ID = '99999999-9999-4999-8999-999999999999';
const REQUEST = '550e8400-e29b-41d4-a716-446655440000';
const BASE = `/outlets/${OUTLET}/sales`;
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

function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    id: SALE_ID,
    outletId: OUTLET,
    outletCode: 'MIRPUR-01',
    outletName: 'Mirpur',
    receiptNumber: 101,
    receiptCode: 'MIRPUR-01-000101',
    requestId: REQUEST,
    createdById: users.staff?.id ?? '',
    totalAmount: '800.00',
    createdAt: new Date('2026-11-26T10:00:00Z'),
    items: [
      {
        menuItemId: ITEM_A,
        itemName: 'Burger',
        quantity: 2,
        unitPrice: '250.00',
        lineTotal: '500.00',
      },
      {
        menuItemId: ITEM_B,
        itemName: 'Fries',
        quantity: 3,
        unitPrice: '100.00',
        lineTotal: '300.00',
      },
    ],
    ...overrides,
  };
}

const body = {
  requestId: REQUEST,
  items: [
    { menuItemId: ITEM_B, quantity: 3, expectedUnitPrice: '100' },
    { menuItemId: ITEM_A, quantity: 2, expectedUnitPrice: '250.00' },
  ],
};

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error', { code, clientVersion: '7' });

let store: Record<keyof SaleStore, Mock>;
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
  const controller = new SaleController(new SaleService(store));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use('/outlets/:outletId/sales', createSaleRouter(controller, fakeAuth, accessService));
  instance.use(errorHandler);
  return instance;
}

const asStaff = { 'x-test-user': 'staff' };
const asAdmin = { 'x-test-user': 'admin' };

beforeEach(() => {
  access = { exists: true, member: true };
  store = {
    createSale: vi.fn(() => Promise.resolve({ kind: 'created', saleId: SALE_ID })),
    findById: vi.fn(() => Promise.resolve(sale())),
    findByRequest: vi.fn(() => Promise.resolve(sale())),
    list: vi.fn(() => Promise.resolve({ items: [], total: 0 })),
  };
});

describe('POST /outlets/:outletId/sales', () => {
  it('normalizes the request, hashes it canonically and returns 201', async () => {
    const response = await request(app()).post(BASE).set(asStaff).send(body).expect(201);
    const items = [
      { menuItemId: ITEM_A, quantity: 2, expectedUnitPrice: '250.00' },
      { menuItemId: ITEM_B, quantity: 3, expectedUnitPrice: '100.00' },
    ];
    expect(store.createSale).toHaveBeenCalledWith({
      userId: users.staff?.id,
      outletId: OUTLET,
      requestId: REQUEST,
      requestHash: hashSaleRequest(items),
      items,
    });
    expect(response.body.data).toMatchObject({
      replayed: false,
      sale: { receiptCode: 'MIRPUR-01-000101', totalAmount: '800.00' },
    });
    expect(JSON.stringify(response.body)).not.toContain('requestHash');
  });

  it('returns 200 with the original sale for an idempotent replay', async () => {
    store.createSale.mockResolvedValueOnce({ kind: 'replay', saleId: SALE_ID });
    const response = await request(app()).post(BASE).set(asStaff).send(body).expect(200);
    expect(response.body.data).toMatchObject({ replayed: true, sale: { id: SALE_ID } });
  });

  it('combines duplicate entries into one line', async () => {
    await request(app())
      .post(BASE)
      .set(asStaff)
      .send({
        requestId: REQUEST,
        items: [
          { menuItemId: ITEM_A, quantity: 1, expectedUnitPrice: '250.00' },
          { menuItemId: ITEM_A, quantity: 4, expectedUnitPrice: '250' },
        ],
      })
      .expect(201);
    expect(store.createSale).toHaveBeenCalledWith(
      expect.objectContaining({
        items: [{ menuItemId: ITEM_A, quantity: 5, expectedUnitPrice: '250.00' }],
      }),
    );
  });

  it.each([
    [{ ...body, items: [] }, 'empty cart'],
    [{ ...body, requestId: 'nope' }, 'bad request id'],
    [{ items: body.items }, 'missing request id'],
    [{ ...body, totalAmount: '1.00' }, 'client total'],
    [{ ...body, receiptNumber: 5 }, 'client receipt'],
    [{ ...body, items: [{ ...body.items[0], quantity: 0 }] }, 'zero quantity'],
    [{ ...body, items: [{ ...body.items[0], quantity: -1 }] }, 'negative quantity'],
    [{ ...body, items: [{ ...body.items[0], quantity: 1.5 }] }, 'fractional quantity'],
    [{ ...body, items: [{ ...body.items[0], quantity: '2' }] }, 'string quantity'],
    [{ ...body, items: [{ ...body.items[0], quantity: 2147483648 }] }, 'quantity overflow'],
    [{ ...body, items: [{ ...body.items[0], expectedUnitPrice: 100 }] }, 'numeric price'],
    [{ ...body, items: [{ ...body.items[0], expectedUnitPrice: 'NaN' }] }, 'NaN price'],
    [{ ...body, items: [{ ...body.items[0], lineTotal: '1.00' }] }, 'client line total'],
    [{ ...body, items: [{ ...body.items[0], itemName: 'Free burger' }] }, 'client item name'],
    [{ ...body, items: Array.from({ length: 101 }, () => body.items[0]) }, '101 entries'],
    [
      {
        requestId: REQUEST,
        items: [
          { menuItemId: ITEM_A, quantity: 1, expectedUnitPrice: '1.00' },
          { menuItemId: ITEM_A, quantity: 1, expectedUnitPrice: '2.00' },
        ],
      },
      'inconsistent duplicate prices',
    ],
    [
      {
        requestId: REQUEST,
        items: [
          { menuItemId: ITEM_A, quantity: 2147483647, expectedUnitPrice: '1.00' },
          { menuItemId: ITEM_A, quantity: 1, expectedUnitPrice: '1.00' },
        ],
      },
      'aggregated overflow',
    ],
  ] as [Record<string, unknown>, string][])('rejects %j (%s)', async (payload, _reason) => {
    await request(app()).post(BASE).set(asStaff).send(payload).expect(400);
    expect(store.createSale).not.toHaveBeenCalled();
  });

  it('is restricted to outlet staff with access', async () => {
    await request(app()).post(BASE).set(asAdmin).send(body).expect(403);
    await request(app()).post(BASE).send(body).expect(401);
    access.member = false;
    await request(app()).post(BASE).set(asStaff).send(body).expect(403);
    expect(store.createSale).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: 'forbidden' }, 403, 'AUTHORIZATION_ERROR'],
    [{ kind: 'outlet-not-found' }, 404, 'NOT_FOUND'],
    [{ kind: 'outlet-inactive' }, 409, 'OUTLET_INACTIVE'],
    [{ kind: 'idempotency-conflict' }, 409, 'IDEMPOTENCY_CONFLICT'],
    [
      { kind: 'unavailable', items: [{ menuItemId: ITEM_A, reason: 'Not available for sale' }] },
      409,
      'ITEM_UNAVAILABLE',
    ],
    [
      {
        kind: 'insufficient',
        items: [{ menuItemId: ITEM_A, requestedQuantity: 7, availableQuantity: 3 }],
      },
      409,
      'INSUFFICIENT_STOCK',
    ],
    [
      {
        kind: 'price-changed',
        items: [{ menuItemId: ITEM_A, expectedUnitPrice: '250.00', currentUnitPrice: '260.00' }],
      },
      409,
      'PRICE_CHANGED',
    ],
    [{ kind: 'total-limit' }, 409, 'SALE_TOTAL_LIMIT_EXCEEDED'],
    [{ kind: 'receipt-limit' }, 409, 'RECEIPT_LIMIT_EXCEEDED'],
    [{ kind: 'counter-missing' }, 500, 'RECEIPT_COUNTER_MISSING'],
  ] as const)('maps %j to %i %s', async (outcome, status, code) => {
    store.createSale.mockResolvedValueOnce(outcome);
    const response = await request(app()).post(BASE).set(asStaff).send(body).expect(status);
    expect(response.body.code).toBe(code);
  });

  it('returns item-specific details for stock and price conflicts', async () => {
    store.createSale.mockResolvedValueOnce({
      kind: 'price-changed',
      items: [{ menuItemId: ITEM_A, expectedUnitPrice: '250.00', currentUnitPrice: '260.00' }],
    });
    const priceResponse = await request(app()).post(BASE).set(asStaff).send(body).expect(409);
    expect(priceResponse.body.errors[0].meta).toEqual({
      menuItemId: ITEM_A,
      expectedUnitPrice: '250.00',
      currentUnitPrice: '260.00',
    });

    store.createSale.mockResolvedValueOnce({
      kind: 'insufficient',
      items: [{ menuItemId: ITEM_A, requestedQuantity: 7, availableQuantity: 3 }],
    });
    const stockResponse = await request(app()).post(BASE).set(asStaff).send(body).expect(409);
    expect(stockResponse.body.errors[0].meta).toMatchObject({ availableQuantity: 3 });
  });

  it('retries aborted transactions with the same request id and hash, boundedly', async () => {
    store.createSale.mockRejectedValueOnce(prismaError('P2034'));
    await request(app()).post(BASE).set(asStaff).send(body).expect(201);
    const [first, second] = store.createSale.mock.calls as [[object], [object]];
    expect(second[0]).toEqual(first[0]);

    store.createSale.mockReset();
    store.createSale.mockRejectedValue(prismaError('P2034'));
    const response = await request(app()).post(BASE).set(asStaff).send(body).expect(409);
    expect(response.body.code).toBe('CONCURRENT_UPDATE');
    expect(store.createSale).toHaveBeenCalledTimes(3);
  });

  it('turns a racing unique violation into a replay on retry', async () => {
    store.createSale
      .mockRejectedValueOnce(prismaError('P2002'))
      .mockResolvedValueOnce({ kind: 'replay', saleId: SALE_ID });
    await request(app()).post(BASE).set(asStaff).send(body).expect(200);
  });

  it('does not retry ambiguous failures', async () => {
    store.createSale.mockRejectedValueOnce(new Error('connection terminated during commit'));
    await request(app()).post(BASE).set(asStaff).send(body).expect(500);
    expect(store.createSale).toHaveBeenCalledTimes(1);
  });
});

describe('reading sales', () => {
  it('scopes history to staff membership and lets HQ read any outlet', async () => {
    await request(app()).get(BASE).set(asStaff).expect(200);
    expect(store.list).toHaveBeenCalledWith(OUTLET, expect.anything(), {
      kind: 'member',
      userId: users.staff?.id,
    });
    await request(app())
      .get(`${BASE}?search=MIRPUR-01-000101&sortBy=totalAmount`)
      .set(asAdmin)
      .expect(200);
    expect(store.list).toHaveBeenLastCalledWith(
      OUTLET,
      expect.objectContaining({ search: 101, sortBy: 'totalAmount' }),
      { kind: 'all' },
    );
  });

  it.each([
    'search=abc',
    'sortBy=createdById',
    'from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
    'from=2026-01-02T00:00:00Z&to=2026-01-02T00:00:00Z',
    'from=2024-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
  ])('rejects %s', async (query) => {
    await request(app()).get(`${BASE}?${query}`).set(asAdmin).expect(400);
  });

  it('blocks staff from other outlets and scopes details by outlet and sale', async () => {
    access.member = false;
    await request(app()).get(`${BASE}/${SALE_ID}`).set(asStaff).expect(403);
    access.member = true;
    store.findById.mockResolvedValueOnce(null);
    await request(app()).get(`${BASE}/${SALE_ID}`).set(asStaff).expect(404);
    expect(store.findById).toHaveBeenCalledWith(OUTLET, SALE_ID, {
      kind: 'member',
      userId: users.staff?.id,
    });
  });

  it('recovers a sale by request id for its originating cashier only', async () => {
    const response = await request(app())
      .get(`${BASE}/by-request/${REQUEST}`)
      .set(asStaff)
      .expect(200);
    expect(response.body.data.sale.id).toBe(SALE_ID);
    expect(store.findByRequest).toHaveBeenCalledWith(OUTLET, REQUEST, users.staff?.id);
    store.findByRequest.mockResolvedValueOnce(null);
    await request(app()).get(`${BASE}/by-request/${REQUEST}`).set(asStaff).expect(404);
    await request(app()).get(`${BASE}/by-request/${REQUEST}`).set(asAdmin).expect(403);
  });
});
