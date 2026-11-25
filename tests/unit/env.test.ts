import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/env.js';

const valid = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/outlethub',
  JWT_SECRET: 'a-secure-test-secret-that-is-long-enough',
  ALLOWED_ORIGINS: 'http://localhost:5173,https://app.example.com',
};

describe('environment configuration', () => {
  it('parses and normalizes valid configuration', () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'https://app.example.com']);
  });

  it('fails fast on a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow('JWT_SECRET');
  });

  it('requires secure cookies with SameSite=None', () => {
    expect(() =>
      loadConfig({ ...valid, COOKIE_SAME_SITE: 'none', COOKIE_SECURE: 'false' }),
    ).toThrow('COOKIE_SECURE');
  });

  it('rejects wildcard and path-based origins', () => {
    expect(() => loadConfig({ ...valid, ALLOWED_ORIGINS: 'https://example.com/path' })).toThrow(
      'Invalid exact origin',
    );
  });

  it('supports only development and production environments', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'test' })).toThrow('NODE_ENV');
  });

  it('accepts Coolify-style postgres:// URLs', () => {
    expect(
      loadConfig({ ...valid, DATABASE_URL: 'postgres://u:p@db.internal:5432/app' }).DATABASE_URL,
    ).toBe('postgres://u:p@db.internal:5432/app');
    expect(() => loadConfig({ ...valid, DATABASE_URL: 'mysql://u:p@db:3306/app' })).toThrow(
      'DATABASE_URL',
    );
  });

  it('enforces production cookie and secret safety', () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: 'production' })).toThrow('COOKIE_SECURE');
    expect(() =>
      loadConfig({
        ...valid,
        NODE_ENV: 'production',
        COOKIE_SECURE: 'true',
        JWT_SECRET: 'replace-with-at-least-32-random-characters',
      }),
    ).toThrow('JWT_SECRET');
  });
});
