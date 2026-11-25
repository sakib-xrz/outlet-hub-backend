import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { verifyPassword } from '@/common/security/password.js';
import { loadConfig } from '@/config/env.js';
import { Prisma } from '@/generated/prisma/client.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { StaffController } from '@/modules/staff/staff.controller.js';
import { createStaffRouter } from '@/modules/staff/staff.route.js';
import { StaffService, type StaffStore } from '@/modules/staff/staff.service.js';
import type { StaffDetail } from '@/modules/staff/staff.types.js';

const STAFF_ID = '2e7fbfc0-d36b-4129-bd85-27e5e04a63a5';
const OUTLET_A = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const OUTLET_B = '0b7e3c1a-2d4f-4a6b-8c9d-1e2f3a4b5c6d';
const PASSWORD = 'correct horse battery staple';

const users: Record<string, AuthenticatedUser> = {
  admin: {
    id: '1d6eaebf-c25a-4018-ac74-16d4df395294',
    email: 'a@example.com',
    role: Role.HQ_ADMIN,
  },
  staff: { id: STAFF_ID, email: 's@example.com', role: Role.OUTLET_STAFF },
};

function detail(overrides: Partial<StaffDetail> = {}): StaffDetail {
  return {
    id: STAFF_ID,
    email: 'staff@example.com',
    role: Role.OUTLET_STAFF,
    isActive: true,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    outlets: [{ id: OUTLET_A, code: 'MIRPUR-01', name: 'Mirpur', isActive: true }],
    ...overrides,
  };
}

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError('Database error', { code, clientVersion: '7' });

let store: Record<keyof StaffStore, Mock>;

function app(rateLimitMax = 10): express.Express {
  const config = loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/outlethub',
    JWT_SECRET: 'a-secure-test-secret-that-is-long-enough',
    ALLOWED_ORIGINS: 'http://localhost:5173',
    AUTH_RATE_LIMIT_MAX: String(rateLimitMax),
  });
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    const user = users[req.header('x-test-user') ?? ''];
    if (user) req.user = user;
    next();
  };
  const controller = new StaffController(new StaffService(store));
  const instance = express();
  instance.use(express.json());
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use('/staff', createStaffRouter(controller, fakeAuth, config));
  instance.use(errorHandler);
  return instance;
}

const asAdmin = { 'x-test-user': 'admin' };

beforeEach(() => {
  store = {
    list: vi.fn(() => Promise.resolve({ items: [{ ...detail(), outletCount: 1 }], total: 21 })),
    findById: vi.fn(() => Promise.resolve(detail())),
    create: vi.fn(() => Promise.resolve({ kind: 'ok', value: STAFF_ID })),
    updateEmail: vi.fn(() => Promise.resolve(true)),
    setActive: vi.fn(() => Promise.resolve({ kind: 'ok', value: undefined })),
    resetPassword: vi.fn(() => Promise.resolve({ kind: 'ok', value: undefined })),
    replaceOutlets: vi.fn(() => Promise.resolve({ kind: 'ok', value: undefined })),
  };
});

describe('staff authorization', () => {
  it.each([
    ['get', '/staff'],
    ['get', `/staff/${STAFF_ID}`],
    ['post', '/staff'],
    ['patch', `/staff/${STAFF_ID}`],
    ['patch', `/staff/${STAFF_ID}/status`],
    ['put', `/staff/${STAFF_ID}/outlets`],
    ['patch', `/staff/${STAFF_ID}/password`],
  ] as const)('%s %s is HQ_ADMIN only', async (method, path) => {
    await request(app())[method](path).expect(401);
    await request(app())[method](path).set('x-test-user', 'staff').expect(403);
  });
});

describe('POST /staff', () => {
  it('normalizes the email, hashes with Argon2id, and returns the created staff', async () => {
    const response = await request(app())
      .post('/staff')
      .set(asAdmin)
      .send({ email: '  New.Staff@Example.COM ', password: PASSWORD, outletIds: [OUTLET_A] })
      .expect(201);

    const [input] = store.create.mock.calls[0] as [
      { email: string; passwordHash: string; outletIds: string[] },
    ];
    expect(input.email).toBe('new.staff@example.com');
    expect(input.outletIds).toEqual([OUTLET_A]);
    expect(input.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(input.passwordHash, PASSWORD)).resolves.toBe(true);
    expect(JSON.stringify(response.body)).not.toMatch(/password/i);
    expect(response.body.data.staff).toMatchObject({ id: STAFF_ID, role: 'OUTLET_STAFF' });
  });

  it('allows creating staff without outlets', async () => {
    await request(app())
      .post('/staff')
      .set(asAdmin)
      .send({ email: 'a@b.co', password: PASSWORD })
      .expect(201);
    expect(store.create).toHaveBeenCalledWith(expect.objectContaining({ outletIds: [] }));
  });

  it.each([
    [{ role: 'HQ_ADMIN' }, 'client-provided role'],
    [{ isActive: false }, 'server-managed status'],
    [{ outletIds: [OUTLET_A, OUTLET_A] }, 'duplicate outlet ids'],
    [{ outletIds: ['not-a-uuid'] }, 'malformed outlet id'],
    [{ password: 'short' }, 'short password'],
    [{ password: 'x'.repeat(129) }, 'oversized password'],
    [{ password: `${' '.repeat(10)}abc` }, 'whitespace password'],
    [{ email: 'not-an-email' }, 'invalid email'],
    [{ password: 'Staff@Example.com' }, 'password equal to email'],
  ] as [Record<string, unknown>, string][])('rejects %j (%s)', async (override, _reason) => {
    await request(app())
      .post('/staff')
      .set(asAdmin)
      .send({ email: 'staff@example.com', password: PASSWORD, ...override })
      .expect(400);
    expect(store.create).not.toHaveBeenCalled();
  });

  it('rejects inactive or missing outlets with a field error', async () => {
    store.create.mockResolvedValueOnce({ kind: 'invalid-outlets', outletIds: [OUTLET_B] });
    const response = await request(app())
      .post('/staff')
      .set(asAdmin)
      .send({ email: 'a@b.co', password: PASSWORD, outletIds: [OUTLET_B] })
      .expect(400);
    expect(response.body.errors[0]).toMatchObject({ field: 'body.outletIds' });
    expect(response.body.errors[0].message).toContain(OUTLET_B);
  });

  it('maps duplicate emails to 409', async () => {
    store.create.mockRejectedValueOnce(prismaError('P2002'));
    const response = await request(app())
      .post('/staff')
      .set(asAdmin)
      .send({ email: 'a@b.co', password: PASSWORD })
      .expect(409);
    expect(response.body.errors).toEqual([
      { field: 'body.email', message: 'This email address is already in use' },
    ]);
  });
});

describe('GET /staff', () => {
  it('passes validated filters and returns pagination', async () => {
    const response = await request(app())
      .get(
        `/staff?page=2&limit=10&search=%20Ali%20&status=active&outletId=${OUTLET_A}&sortBy=email&sortOrder=asc`,
      )
      .set(asAdmin)
      .expect(200);
    expect(store.list).toHaveBeenCalledWith({
      page: 2,
      limit: 10,
      search: 'Ali',
      status: 'active',
      outletId: OUTLET_A,
      sortBy: 'email',
      sortOrder: 'asc',
    });
    expect(response.body.data.pagination).toEqual({ page: 2, limit: 10, total: 21, totalPages: 3 });
    expect(response.body.data.items[0].outletCount).toBe(1);
  });

  it.each(['outletId=x', 'sortBy=role', 'sortBy=passwordHash', 'limit=101', 'role=HQ_ADMIN'])(
    'rejects %s',
    async (query) => {
      await request(app()).get(`/staff?${query}`).set(asAdmin).expect(400);
    },
  );
});

describe('GET /staff/:staffId', () => {
  it('returns 404 for missing or non-staff accounts and 400 for bad ids', async () => {
    store.findById.mockResolvedValueOnce(null);
    await request(app()).get(`/staff/${STAFF_ID}`).set(asAdmin).expect(404);
    await request(app()).get('/staff/abc').set(asAdmin).expect(400);
  });
});

describe('PATCH /staff/:staffId', () => {
  it('updates only the normalized email', async () => {
    await request(app())
      .patch(`/staff/${STAFF_ID}`)
      .set(asAdmin)
      .send({ email: ' X@Y.CO ' })
      .expect(200);
    expect(store.updateEmail).toHaveBeenCalledWith(STAFF_ID, 'x@y.co');
  });

  it.each([
    {},
    { role: 'HQ_ADMIN' },
    { email: 'a@b.co', password: PASSWORD },
    { isActive: true },
    { outletIds: [] },
  ])('rejects %j', async (body) => {
    await request(app()).patch(`/staff/${STAFF_ID}`).set(asAdmin).send(body).expect(400);
  });

  it('returns 404 for non-staff targets and 409 for taken emails', async () => {
    store.updateEmail.mockResolvedValueOnce(false);
    await request(app())
      .patch(`/staff/${STAFF_ID}`)
      .set(asAdmin)
      .send({ email: 'a@b.co' })
      .expect(404);
    store.updateEmail.mockRejectedValueOnce(prismaError('P2002'));
    await request(app())
      .patch(`/staff/${STAFF_ID}`)
      .set(asAdmin)
      .send({ email: 'a@b.co' })
      .expect(409);
  });
});

describe('PATCH /staff/:staffId/status', () => {
  it('sets the status and returns the staff member', async () => {
    store.findById.mockResolvedValueOnce(detail({ isActive: false }));
    const response = await request(app())
      .patch(`/staff/${STAFF_ID}/status`)
      .set(asAdmin)
      .send({ isActive: false })
      .expect(200);
    expect(store.setActive).toHaveBeenCalledWith(STAFF_ID, false);
    expect(response.body.data.staff.isActive).toBe(false);
  });

  it('requires a strict boolean and an existing staff member', async () => {
    await request(app())
      .patch(`/staff/${STAFF_ID}/status`)
      .set(asAdmin)
      .send({ isActive: 'false' })
      .expect(400);
    store.setActive.mockResolvedValueOnce({ kind: 'not-found' });
    await request(app())
      .patch(`/staff/${STAFF_ID}/status`)
      .set(asAdmin)
      .send({ isActive: true })
      .expect(404);
  });
});

describe('PUT /staff/:staffId/outlets', () => {
  it('replaces assignments, including with an empty set', async () => {
    await request(app())
      .put(`/staff/${STAFF_ID}/outlets`)
      .set(asAdmin)
      .send({ outletIds: [] })
      .expect(200);
    expect(store.replaceOutlets).toHaveBeenCalledWith(STAFF_ID, []);
  });

  it('rejects duplicates, missing bodies and invalid outlets', async () => {
    await request(app())
      .put(`/staff/${STAFF_ID}/outlets`)
      .set(asAdmin)
      .send({ outletIds: [OUTLET_A, OUTLET_A] })
      .expect(400);
    await request(app()).put(`/staff/${STAFF_ID}/outlets`).set(asAdmin).send({}).expect(400);
    store.replaceOutlets.mockResolvedValueOnce({ kind: 'invalid-outlets', outletIds: [OUTLET_B] });
    await request(app())
      .put(`/staff/${STAFF_ID}/outlets`)
      .set(asAdmin)
      .send({ outletIds: [OUTLET_B] })
      .expect(400);
  });
});

describe('PATCH /staff/:staffId/password', () => {
  it('stores a new Argon2id hash and returns a generic response', async () => {
    const response = await request(app())
      .patch(`/staff/${STAFF_ID}/password`)
      .set(asAdmin)
      .send({ newPassword: PASSWORD })
      .expect(200);
    const [, hash] = store.resetPassword.mock.calls[0] as [string, string];
    await expect(verifyPassword(hash, PASSWORD)).resolves.toBe(true);
    expect(response.body).toMatchObject({ success: true, data: {} });
    expect(JSON.stringify(response.body)).not.toContain(PASSWORD);
  });

  it('validates the password and the target', async () => {
    await request(app())
      .patch(`/staff/${STAFF_ID}/password`)
      .set(asAdmin)
      .send({ newPassword: 'short' })
      .expect(400);
    await request(app())
      .patch(`/staff/${STAFF_ID}/password`)
      .set(asAdmin)
      .send({ newPassword: PASSWORD, password: PASSWORD })
      .expect(400);
    store.resetPassword.mockResolvedValueOnce({ kind: 'not-found' });
    await request(app())
      .patch(`/staff/${STAFF_ID}/password`)
      .set(asAdmin)
      .send({ newPassword: PASSWORD })
      .expect(404);
  });

  it('rate limits password resets per administrator', async () => {
    const limited = app(2);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await request(limited)
        .patch(`/staff/${STAFF_ID}/password`)
        .set(asAdmin)
        .send({ newPassword: PASSWORD })
        .expect(200);
    }
    const response = await request(limited)
      .patch(`/staff/${STAFF_ID}/password`)
      .set(asAdmin)
      .send({ newPassword: PASSWORD })
      .expect(429);
    expect(response.body.code).toBe('RATE_LIMITED');
  });
});
