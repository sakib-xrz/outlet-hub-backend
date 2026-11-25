import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import type { AppConfig } from '@/config/env.js';
import { AuthenticationError } from '@/common/errors/app-error.js';
import { Role } from '@/generated/prisma/enums.js';
import type { AccessTokenClaims, PublicUser } from '@/modules/auth/auth.types.js';

export class TokenService {
  private readonly secret: Uint8Array;

  public constructor(private readonly config: AppConfig) {
    this.secret = new TextEncoder().encode(config.JWT_SECRET);
  }

  public async signAccessToken(user: PublicUser): Promise<string> {
    return new SignJWT({ email: user.email, role: user.role })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(user.id)
      .setIssuer(this.config.JWT_ISSUER)
      .setAudience(this.config.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${this.config.JWT_ACCESS_TTL_SECONDS}s`)
      .sign(this.secret);
  }

  public async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload, protectedHeader } = await jwtVerify(token, this.secret, {
        algorithms: ['HS256'],
        issuer: this.config.JWT_ISSUER,
        audience: this.config.JWT_AUDIENCE,
        clockTolerance: 5,
      });
      if (
        protectedHeader.alg !== 'HS256' ||
        !payload.sub ||
        typeof payload.email !== 'string' ||
        !Object.values(Role).includes(payload.role as Role)
      ) {
        throw new Error('Invalid token claims');
      }
      return { id: payload.sub, email: payload.email, role: payload.role as Role };
    } catch {
      throw new AuthenticationError('Invalid or expired access token');
    }
  }

  public createRefreshToken(): string {
    return randomBytes(32).toString('base64url');
  }

  public hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }
}
