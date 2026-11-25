import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { OutletAccessService } from '@/modules/access/outlet-access.service.js';
import { OutletController } from '@/modules/outlets/outlet.controller.js';
import { createOutletRouter } from '@/modules/outlets/outlet.route.js';
import { OutletService, type OutletStore } from '@/modules/outlets/outlet.service.js';
import type { Outlet } from '@/modules/outlets/outlet.types.js';

const OUTLET_ID = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
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

function outlet(overrides: Partial<Outlet> = {}): Outlet {
  return {
    id: OUTLET_ID,
    code: 'MIRPUR-01',
    name: 'Mirpur Outlet',
    address: null,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function prismaError(code: string): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Database error', { code, clientVersion: '7' });
}

let store: { [K in keyof OutletStore]: ReturnType<typeof vi.fn> };
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
  const controller = new OutletController(new OutletService(store as unknown as OutletStore));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use('/outlets', createOutletRouter(controller, fakeAuth, accessService));
  instance.use(errorHandler);
  return instance;
}

const as = (user: 'admin' | 'staff'): Record<string, string> => ({ 'x-test-user': user });

beforeEach(() => {
  access = { exists: true, member: true };
  store = {
    list: vi.fn(() => Promise.resolve({ items: [outlet()], total: 41 })),
    findById: vi.fn(() => Promise.resolve(outlet())),
    createWithReceiptCounter: vi.fn((input: object) => Promise.resolve(outlet(input))),
    update: vi.fn((_id: string, input: object) => Promise.resolve(outlet(input))),
    setActive: vi.fn((_id: string, isActive: boolean) => Promise.resolve(outlet({ isActive }))),
  };
});

describe('POST /outlets', () => {
  it('creates an outlet with a normalized code and returns 201', async () => {
    const response = await request(app())
      .post('/outlets')
      .set(as('admin'))
      .send({ code: '  mirpur-01 ', name: ' Mirpur Outlet ', address: '  ' })
      .expect(201);
    expect(store.createWithReceiptCounter).toHaveBeenCalledWith({
      code: 'MIRPUR-01',
      name: 'Mirpur Outlet',
      address: null,
    });
    expect(response.body.data.outlet.code).toBe('MIRPUR-01');
  });

  it('rejects server-managed and unknown fields', async () => {
    const response = await request(app())
      .post('/outlets')
      .set(as('admin'))
      .send({ code: 'A-1', name: 'A', id: OUTLET_ID, isActive: false })
      .expect(400);
    expect(response.body.code).toBe('VALIDATION_ERROR');
    expect(store.createWithReceiptCounter).not.toHaveBeenCalled();
  });

  it.each(['', 'A', 'BAD CODE', '-LEADING', 'DOUBLE--HYPHEN', 'X'.repeat(21)])(
    'rejects invalid code %j',
    async (code) => {
      await request(app()).post('/outlets').set(as('admin')).send({ code, name: 'A' }).expect(400);
    },
  );

  it('maps a database uniqueness violation to 409 with a field error', async () => {
    store.createWithReceiptCounter.mockRejectedValueOnce(prismaError('P2002'));
    const response = await request(app())
      .post('/outlets')
      .set(as('admin'))
      .send({ code: 'MIRPUR-01', name: 'Mirpur' })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'CONFLICT' });
    expect(response.body.errors).toEqual([
      { field: 'body.code', message: 'This outlet code is already in use' },
    ]);
  });

  it('is limited to HQ admins and authenticated users', async () => {
    await request(app())
      .post('/outlets')
      .set(as('staff'))
      .send({ code: 'A-1', name: 'A' })
      .expect(403);
    await request(app()).post('/outlets').send({ code: 'A-1', name: 'A' }).expect(401);
    expect(store.createWithReceiptCounter).not.toHaveBeenCalled();
  });
});

describe('PATCH /outlets/:outletId', () => {
  it('applies a partial update and allows clearing the address', async () => {
    await request(app())
      .patch(`/outlets/${OUTLET_ID}`)
      .set(as('admin'))
      .send({ address: null })
      .expect(200);
    expect(store.update).toHaveBeenCalledWith(OUTLET_ID, { address: null });
  });

  it('keeps outlet codes and status immutable through this endpoint', async () => {
    for (const body of [{ code: 'NEW-01' }, { isActive: false }, { name: 'A', createdAt: 'x' }]) {
      await request(app()).patch(`/outlets/${OUTLET_ID}`).set(as('admin')).send(body).expect(400);
    }
    expect(store.update).not.toHaveBeenCalled();
  });

  it('requires at least one field', async () => {
    await request(app()).patch(`/outlets/${OUTLET_ID}`).set(as('admin')).send({}).expect(400);
  });

  it('returns 400 for an invalid id and 404 for a missing outlet', async () => {
    await request(app())
      .patch('/outlets/not-a-uuid')
      .set(as('admin'))
      .send({ name: 'A' })
      .expect(400);
    store.update.mockRejectedValueOnce(prismaError('P2025'));
    await request(app())
      .patch(`/outlets/${OUTLET_ID}`)
      .set(as('admin'))
      .send({ name: 'A' })
      .expect(404);
  });

  it('forbids staff', async () => {
    await request(app())
      .patch(`/outlets/${OUTLET_ID}`)
      .set(as('staff'))
      .send({ name: 'A' })
      .expect(403);
  });
});

describe('PATCH /outlets/:outletId/status', () => {
  it('deactivates and reactivates an outlet', async () => {
    const response = await request(app())
      .patch(`/outlets/${OUTLET_ID}/status`)
      .set(as('admin'))
      .send({ isActive: false })
      .expect(200);
    expect(response.body.data.outlet.isActive).toBe(false);
    expect(store.setActive).toHaveBeenCalledWith(OUTLET_ID, false);
  });

  it('is idempotent when the outlet already has the requested status', async () => {
    const response = await request(app())
      .patch(`/outlets/${OUTLET_ID}/status`)
      .set(as('admin'))
      .send({ isActive: true })
      .expect(200);
    expect(response.body.data.outlet.isActive).toBe(true);
    expect(store.setActive).not.toHaveBeenCalled();
  });

  it('requires a strict boolean', async () => {
    for (const body of [
      { isActive: 'false' },
      { isActive: 0 },
      {},
      { isActive: true, name: 'x' },
    ]) {
      await request(app())
        .patch(`/outlets/${OUTLET_ID}/status`)
        .set(as('admin'))
        .send(body)
        .expect(400);
    }
  });

  it('returns 404 for a missing outlet and 403 for staff', async () => {
    store.findById.mockResolvedValue(null);
    await request(app())
      .patch(`/outlets/${OUTLET_ID}/status`)
      .set(as('admin'))
      .send({ isActive: false })
      .expect(404);
    await request(app())
      .patch(`/outlets/${OUTLET_ID}/status`)
      .set(as('staff'))
      .send({ isActive: false })
      .expect(403);
  });
});

describe('GET /outlets', () => {
  it('coerces and applies defaults to query parameters', async () => {
    const response = await request(app())
      .get('/outlets?page=3&limit=10&search=%20mir%20&status=inactive&sortBy=name&sortOrder=asc')
      .set(as('admin'))
      .expect(200);
    expect(store.list).toHaveBeenCalledWith(
      { page: 3, limit: 10, search: 'mir', status: 'inactive', sortBy: 'name', sortOrder: 'asc' },
      { kind: 'all' },
    );
    expect(response.body.data.pagination).toEqual({ page: 3, limit: 10, total: 41, totalPages: 5 });

    await request(app()).get('/outlets').set(as('admin')).expect(200);
    expect(store.list).toHaveBeenLastCalledWith(
      { page: 1, limit: 20, status: 'all', sortBy: 'createdAt', sortOrder: 'desc' },
      { kind: 'all' },
    );
  });

  it('scopes staff listings to their memberships', async () => {
    await request(app()).get('/outlets').set(as('staff')).expect(200);
    expect(store.list).toHaveBeenCalledWith(expect.anything(), {
      kind: 'member',
      userId: users.staff?.id,
    });
  });

  it.each([
    'limit=101',
    'limit=0',
    'page=0',
    'page=abc',
    'sortBy=password',
    'sortOrder=sideways',
    'status=deleted',
    `search=${'x'.repeat(101)}`,
    'unknown=1',
    'page=1&page=2',
  ])('rejects %s', async (query) => {
    await request(app()).get(`/outlets?${query}`).set(as('admin')).expect(400);
  });

  it('requires authentication', async () => {
    await request(app()).get('/outlets').expect(401);
  });
});

describe('GET /outlets/:outletId', () => {
  it('returns the outlet for an authorized user', async () => {
    const response = await request(app()).get(`/outlets/${OUTLET_ID}`).set(as('staff')).expect(200);
    expect(response.body.data.outlet).toMatchObject({ id: OUTLET_ID, code: 'MIRPUR-01' });
  });

  it('returns 404 to HQ admins for missing outlets', async () => {
    access.exists = false;
    await request(app()).get(`/outlets/${OUTLET_ID}`).set(as('admin')).expect(404);
  });

  it('returns 403 to staff without an active membership', async () => {
    access.member = false;
    await request(app()).get(`/outlets/${OUTLET_ID}`).set(as('staff')).expect(403);
    expect(store.findById).not.toHaveBeenCalled();
  });

  it('rejects malformed ids', async () => {
    await request(app()).get('/outlets/123').set(as('admin')).expect(400);
  });
});
