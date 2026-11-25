import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '@/app.js';
import { loadConfig } from '@/config/env.js';
import { createLogger } from '@/config/logger.js';
import type { DatabaseClient } from '@/database/client.js';

const ORIGIN = 'https://app.example.com';
const config = loadConfig({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/never_connected',
  JWT_SECRET: 'x'.repeat(48),
  ALLOWED_ORIGINS: ORIGIN,
  LOG_LEVEL: 'silent',
});
const app = createApp({
  config,
  database: {} as DatabaseClient,
  logger: createLogger(config),
});

describe('CORS preflight', () => {
  it.each(['GET', 'POST', 'PATCH', 'PUT'])('allows %s from a trusted origin', async (method) => {
    const response = await request(app)
      .options('/api/v1/outlets/6f0c2b1e-9a43-4c2f-8f7e-0b8f1d2a3c4d/inventory/x/adjust')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', method)
      .set('Access-Control-Request-Headers', 'authorization,content-type');
    expect(response.status).toBe(204);
    expect(response.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(response.headers['access-control-allow-methods']?.split(',')).toContain(method);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
  });

  it('does not advertise DELETE, which the API never uses', async () => {
    const response = await request(app)
      .options('/api/v1/outlets')
      .set('Origin', ORIGIN)
      .set('Access-Control-Request-Method', 'DELETE');
    expect(response.headers['access-control-allow-methods']?.split(',')).not.toContain('DELETE');
  });

  it('refuses untrusted origins', async () => {
    const response = await request(app)
      .options('/api/v1/outlets')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PATCH');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});
