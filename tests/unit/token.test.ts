import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '@/config/env.js';
import { Role } from '@/generated/prisma/enums.js';
import { TokenService } from '@/modules/auth/token.service.js';

const config = loadConfig({
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://user:password@localhost:5432/outlethub',
  JWT_SECRET: 'a-secure-test-secret-that-is-long-enough',
  JWT_ISSUER: 'issuer',
  JWT_AUDIENCE: 'audience',
  ALLOWED_ORIGINS: 'http://localhost:5173',
});

describe('TokenService', () => {
  const service = new TokenService(config);

  it('signs and verifies constrained access tokens', async () => {
    const user = {
      id: '1d6eaebf-c25a-4018-ac74-16d4df395294',
      email: 'admin@example.com',
      role: Role.HQ_ADMIN,
    };
    await expect(service.verifyAccessToken(await service.signAccessToken(user))).resolves.toEqual(
      user,
    );
  });

  it('rejects expired tokens', async () => {
    const expired = await new SignJWT({ email: 'admin@example.com', role: Role.HQ_ADMIN })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('1d6eaebf-c25a-4018-ac74-16d4df395294')
      .setIssuer(config.JWT_ISSUER)
      .setAudience(config.JWT_AUDIENCE)
      .setExpirationTime(1)
      .sign(new TextEncoder().encode(config.JWT_SECRET));
    await expect(service.verifyAccessToken(expired)).rejects.toMatchObject({
      code: 'AUTHENTICATION_ERROR',
    });
  });

  it('creates unguessable tokens and deterministic non-plaintext hashes', () => {
    const token = service.createRefreshToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(service.hashRefreshToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(service.hashRefreshToken(token)).not.toContain(token);
  });
});
