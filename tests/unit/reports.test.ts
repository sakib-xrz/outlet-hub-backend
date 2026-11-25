import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { Role } from '@/generated/prisma/enums.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';
import { ReportController } from '@/modules/reports/report.controller.js';
import { createReportRouter } from '@/modules/reports/report.route.js';
import { ReportService, type ReportStore } from '@/modules/reports/report.service.js';

const OUTLET = '6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d';
const FROM = '2026-11-01T00:00:00+06:00';
const TO = '2026-12-01T00:00:00+06:00';
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
const asAdmin = { 'x-test-user': 'admin' };
const asStaff = { 'x-test-user': 'staff' };

let store: Record<keyof ReportStore, Mock>;

function app(): express.Express {
  const fakeAuth: express.RequestHandler = (req, _res, next) => {
    const user = users[req.header('x-test-user') ?? ''];
    if (user) req.user = user;
    next();
  };
  const instance = express();
  instance.use(requestId);
  instance.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    next();
  });
  instance.use(
    '/reports',
    createReportRouter(new ReportController(new ReportService(store)), fakeAuth),
  );
  instance.use(errorHandler);
  return instance;
}

beforeEach(() => {
  store = {
    summary: vi.fn(() =>
      Promise.resolve({
        totalRevenue: '148500.00',
        totalSales: '594',
        totalUnitsSold: '1248',
        totalOutlets: 5,
        activeOutlets: 4,
      }),
    ),
    revenueByOutlet: vi.fn(() => Promise.resolve({ items: [], total: 41 })),
    topSellingItems: vi.fn(() =>
      Promise.resolve({
        outlet: { id: OUTLET, code: 'MIRPUR-01', name: 'Mirpur', isActive: false },
        items: [],
      }),
    ),
  };
});

describe('authorization', () => {
  it.each([
    '/reports/summary',
    '/reports/revenue-by-outlet',
    `/reports/outlets/${OUTLET}/top-selling-items`,
  ])('rejects staff (403) and anonymous (401) on %s', async (path) => {
    await request(app()).get(path).set(asStaff).expect(403);
    await request(app()).get(path).expect(401);
    expect(store.summary).not.toHaveBeenCalled();
    expect(store.revenueByOutlet).not.toHaveBeenCalled();
    expect(store.topSellingItems).not.toHaveBeenCalled();
  });
});

describe('GET /reports/summary', () => {
  it('returns all-time figures when no range is given', async () => {
    const response = await request(app()).get('/reports/summary').set(asAdmin).expect(200);
    expect(store.summary).toHaveBeenCalledWith(null);
    expect(response.body.data).toEqual({
      totalRevenue: '148500.00',
      totalSales: '594',
      totalUnitsSold: '1248',
      totalOutlets: 5,
      activeOutlets: 4,
    });
  });

  it('passes a half-open range as absolute instants', async () => {
    await request(app())
      .get('/reports/summary')
      .query({ from: FROM, to: TO })
      .set(asAdmin)
      .expect(200);
    expect(store.summary).toHaveBeenCalledWith({
      from: new Date('2026-10-31T18:00:00Z'),
      to: new Date('2026-11-30T18:00:00Z'),
    });
  });

  it.each([
    [{ from: FROM }, 'to'],
    [{ to: TO }, 'from'],
    [{ from: '2026-11-01', to: TO }, 'from'],
    [{ from: '2026-11-01T00:00:00', to: TO }, 'from'],
    [{ from: 'yesterday', to: TO }, 'from'],
    [{ from: TO, to: FROM }, 'to'],
    [{ from: FROM, to: FROM }, 'to'],
    [{ from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }, 'to'],
  ])('rejects invalid range %o', async (query, field) => {
    const response = await request(app())
      .get('/reports/summary')
      .query(query)
      .set(asAdmin)
      .expect(400);
    expect(response.body.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: `query.${field}` })]),
    );
    expect(store.summary).not.toHaveBeenCalled();
  });

  it('accepts exactly 366 days', async () => {
    await request(app())
      .get('/reports/summary')
      .query({ from: '2028-01-01T00:00:00Z', to: '2029-01-01T00:00:00Z' })
      .set(asAdmin)
      .expect(200);
  });

  it('rejects unknown parameters', async () => {
    await request(app())
      .get('/reports/summary')
      .query({ outletId: OUTLET })
      .set(asAdmin)
      .expect(400);
  });

  it('returns a 500 without leaking details when an aggregate is corrupted', async () => {
    store.summary.mockRejectedValueOnce(new Error('Corrupted monetary aggregate: NaN'));
    const response = await request(app()).get('/reports/summary').set(asAdmin).expect(500);
    expect(JSON.stringify(response.body)).not.toContain('NaN');
  });
});

describe('GET /reports/revenue-by-outlet', () => {
  it('applies defaults and builds pagination', async () => {
    const response = await request(app())
      .get('/reports/revenue-by-outlet')
      .set(asAdmin)
      .expect(200);
    expect(store.revenueByOutlet).toHaveBeenCalledWith(null, {
      page: 1,
      limit: 20,
      sortBy: 'totalRevenue',
      sortOrder: 'desc',
    });
    expect(response.body.data.pagination).toEqual({ page: 1, limit: 20, total: 41, totalPages: 3 });
  });

  it('forwards search, sort, range and paging', async () => {
    await request(app())
      .get('/reports/revenue-by-outlet')
      .query({
        from: FROM,
        to: TO,
        page: 2,
        limit: 5,
        search: '  mir ',
        sortBy: 'code',
        sortOrder: 'asc',
      })
      .set(asAdmin)
      .expect(200);
    expect(store.revenueByOutlet).toHaveBeenCalledWith(
      { from: new Date(FROM), to: new Date(TO) },
      expect.objectContaining({
        page: 2,
        limit: 5,
        search: 'mir',
        sortBy: 'code',
        sortOrder: 'asc',
      }),
    );
  });

  it.each([
    { sortBy: 'name; DROP TABLE sales' },
    { sortOrder: 'sideways' },
    { limit: 101 },
    { page: 0 },
    { search: 'x'.repeat(101) },
  ])('rejects %o', async (query) => {
    await request(app()).get('/reports/revenue-by-outlet').query(query).set(asAdmin).expect(400);
    expect(store.revenueByOutlet).not.toHaveBeenCalled();
  });
});

describe('GET /reports/outlets/:outletId/top-selling-items', () => {
  it('returns inactive outlets too', async () => {
    const response = await request(app())
      .get(`/reports/outlets/${OUTLET}/top-selling-items`)
      .set(asAdmin)
      .expect(200);
    expect(store.topSellingItems).toHaveBeenCalledWith(OUTLET, null);
    expect(response.body.data.outlet.isActive).toBe(false);
  });

  it('returns 404 for an unknown outlet', async () => {
    store.topSellingItems.mockResolvedValueOnce(null);
    const response = await request(app())
      .get(`/reports/outlets/${OUTLET}/top-selling-items`)
      .set(asAdmin)
      .expect(404);
    expect(response.body.code).toBe('NOT_FOUND');
  });

  it('rejects a malformed outlet id and an invalid range', async () => {
    await request(app()).get('/reports/outlets/nope/top-selling-items').set(asAdmin).expect(400);
    await request(app())
      .get(`/reports/outlets/${OUTLET}/top-selling-items`)
      .query({ from: FROM })
      .set(asAdmin)
      .expect(400);
    expect(store.topSellingItems).not.toHaveBeenCalled();
  });
});
