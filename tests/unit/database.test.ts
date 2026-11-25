import { describe, expect, it } from 'vitest';
import { buildDatabaseOptions } from '@/database/client.js';

describe('database connection options', () => {
  it('extracts the schema and applies pool limits', () => {
    const { pool, schema } = buildDatabaseOptions({
      DATABASE_URL:
        'postgresql://user:password@db.example.com:5432/outlethub?schema=public&sslmode=require',
      DATABASE_POOL_MAX: 7,
      DATABASE_CONNECTION_TIMEOUT_MS: 4000,
      DATABASE_IDLE_TIMEOUT_MS: 20_000,
    });
    expect(pool.connectionString).toBe(
      'postgresql://user:password@db.example.com:5432/outlethub?sslmode=require',
    );
    expect(schema).toBe('public');
    expect(pool).toMatchObject({
      max: 7,
      connectionTimeoutMillis: 4000,
      idleTimeoutMillis: 20_000,
    });
  });

  it('pins every session to UTC so Date parameters are not shifted by the server time zone', () => {
    const { pool } = buildDatabaseOptions({
      DATABASE_URL: 'postgresql://user:password@localhost:5432/outlethub',
      DATABASE_POOL_MAX: 1,
      DATABASE_CONNECTION_TIMEOUT_MS: 1000,
      DATABASE_IDLE_TIMEOUT_MS: 1000,
    });
    expect(pool.options).toBe('-c TimeZone=UTC');
  });
});
