import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { Role } from '@/generated/prisma/enums.js';
import { authorize } from '@/middlewares/authenticate.js';
import { errorHandler } from '@/middlewares/error-handler.js';
import { requestId } from '@/middlewares/request-id.js';

function testApp(role: Role): express.Express {
  const app = express();
  app.use(requestId);
  app.use((req, _res, next) => {
    req.log = { warn: () => undefined, error: () => undefined } as never;
    req.user = { id: 'id', email: 'user@example.com', role };
    next();
  });
  app.get('/admin', authorize(Role.HQ_ADMIN), (_req, res) => res.json({ ok: true }));
  app.use(errorHandler);
  return app;
}

describe('role authorization', () => {
  it('allows an authorized role', async () => {
    await request(testApp(Role.HQ_ADMIN)).get('/admin').expect(200, { ok: true });
  });

  it('returns a consistent error for a forbidden role', async () => {
    const response = await request(testApp(Role.OUTLET_STAFF)).get('/admin').expect(403);
    expect(response.body).toMatchObject({ success: false, code: 'AUTHORIZATION_ERROR' });
    expect(response.body.requestId).toBeTypeOf('string');
  });
});
