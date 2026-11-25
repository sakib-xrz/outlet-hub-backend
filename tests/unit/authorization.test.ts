import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { loadConfig } from '@/config/env.js';
import { Role } from '@/generated/prisma/enums.js';
import { type ActiveUserLookup, authenticate } from '@/middlewares/authenticate.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requireOutletAccess } from '@/middlewares/outlet-access.js';
import { requestId } from '@/middlewares/request-id.js';
import {
  OutletAccessService,
  type OutletAccessStore,
} from '@/modules/access/outlet-access.service.js';
import { TokenService } from '@/modules/auth/token.service.js';

const tokens = new TokenService(
  loadConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://user:password@localhost:5432/outlethub',
    JWT_SECRET: 'a-secure-test-secret-that-is-long-enough',
    ALLOWED_ORIGINS: 'http://localhost:5173',
  }),
);

const userId = '1d6eaebf-c25a-4018-ac74-16d4df395294';
const outletId = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const admin: AuthenticatedUser = { id: userId, email: 'admin@example.com', role: Role.HQ_ADMIN };
const staff: AuthenticatedUser = {
  id: userId,
  email: 'staff@example.com',
  role: Role.OUTLET_STAFF,
};

function app(...handlers: express.RequestHandler[]): express.Express {
  const instance = express();
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.get('/outlets/:outletId', ...handlers, (req, res) => res.json({ user: req.user }));
  instance.use(errorHandler);
  return instance;
}

type MockFn = ReturnType<typeof vi.fn>;

function withUser(user: AuthenticatedUser): express.RequestHandler {
  return (req, _res, next) => {
    req.user = user;
    next();
  };
}

function lookup(user: AuthenticatedUser | null): {
  users: ActiveUserLookup;
  findActiveUserById: MockFn;
} {
  const findActiveUserById = vi.fn(() => Promise.resolve(user));
  const users: ActiveUserLookup = { findActiveUserById };
  return { users, findActiveUserById };
}

function repository(options: { exists?: boolean; member?: boolean }): {
  repo: OutletAccessStore;
  outletExists: MockFn;
  hasActiveMembership: MockFn;
} {
  const outletExists = vi.fn(() => Promise.resolve(options.exists ?? false));
  const hasActiveMembership = vi.fn(() => Promise.resolve(options.member ?? false));
  return { repo: { outletExists, hasActiveMembership }, outletExists, hasActiveMembership };
}

describe('authenticate', () => {
  it('uses the current database identity instead of stale token claims', async () => {
    const token = await tokens.signAccessToken(admin);
    const response = await request(app(authenticate(tokens, lookup(staff).users)))
      .get(`/outlets/${outletId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(response.body.user.role).toBe(Role.OUTLET_STAFF);
  });

  it('rejects a valid token for a deactivated or deleted user', async () => {
    const token = await tokens.signAccessToken(admin);
    const response = await request(app(authenticate(tokens, lookup(null).users)))
      .get(`/outlets/${outletId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(401);
    expect(response.body.code).toBe('AUTHENTICATION_ERROR');
  });

  it('rejects missing and invalid tokens without a database lookup', async () => {
    const { users, findActiveUserById } = lookup(admin);
    const handler = authenticate(tokens, users);
    await request(app(handler)).get(`/outlets/${outletId}`).expect(401);
    await request(app(handler))
      .get(`/outlets/${outletId}`)
      .set('Authorization', 'Bearer not-a-jwt')
      .expect(401);
    expect(findActiveUserById).not.toHaveBeenCalled();
  });
});

describe('OutletAccessService', () => {
  it('lets HQ admins access any existing outlet without membership', async () => {
    const { repo, hasActiveMembership } = repository({ exists: true });
    await expect(
      new OutletAccessService(repo).assertCanAccessOutlet(admin, outletId),
    ).resolves.toBeUndefined();
    expect(hasActiveMembership).not.toHaveBeenCalled();
  });

  it('reports a missing outlet to HQ admins as not found', async () => {
    await expect(
      new OutletAccessService(repository({ exists: false }).repo).assertCanAccessOutlet(
        admin,
        outletId,
      ),
    ).rejects.toMatchObject({ statusCode: 404, code: 'NOT_FOUND' });
  });

  it('requires staff to hold a membership in an active outlet', async () => {
    const { repo, hasActiveMembership } = repository({ member: true });
    await expect(
      new OutletAccessService(repo).assertCanAccessOutlet(staff, outletId),
    ).resolves.toBeUndefined();
    expect(hasActiveMembership).toHaveBeenCalledWith(userId, outletId, undefined);
  });

  it('forbids staff without membership without revealing whether the outlet exists', async () => {
    const { repo, outletExists } = repository({ exists: true, member: false });
    await expect(
      new OutletAccessService(repo).assertCanAccessOutlet(staff, outletId),
    ).rejects.toMatchObject({
      statusCode: 403,
      code: 'AUTHORIZATION_ERROR',
    });
    expect(outletExists).not.toHaveBeenCalled();
  });

  it('runs checks on a supplied transaction client', async () => {
    const { repo, hasActiveMembership } = repository({ member: true });
    const transaction = {} as never;
    await new OutletAccessService(repo).assertCanAccessOutlet(staff, outletId, transaction);
    expect(hasActiveMembership).toHaveBeenCalledWith(userId, outletId, transaction);
  });
});

describe('requireOutletAccess', () => {
  const allowAll = { assertCanAccessOutlet: vi.fn(() => Promise.resolve()) };

  it('validates the outlet id before checking access', async () => {
    const response = await request(app(withUser(staff), requireOutletAccess(allowAll)))
      .get('/outlets/not-a-uuid')
      .expect(400);
    expect(response.body.errors).toEqual([
      { field: 'params.outletId', message: 'Invalid outlet id' },
    ]);
  });

  it('requires an authenticated user', async () => {
    await request(app(requireOutletAccess(allowAll)))
      .get(`/outlets/${outletId}`)
      .expect(401);
  });

  it('allows members and blocks non-members', async () => {
    const service = new OutletAccessService(repository({ member: false }).repo);
    await request(app(withUser(staff), requireOutletAccess(service)))
      .get(`/outlets/${outletId}`)
      .expect(403);

    const member = new OutletAccessService(repository({ member: true }).repo);
    await request(app(withUser(staff), requireOutletAccess(member)))
      .get(`/outlets/${outletId}`)
      .expect(200);
  });
});
