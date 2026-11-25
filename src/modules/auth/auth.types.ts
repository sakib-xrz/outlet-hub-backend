import type { Role } from '@/generated/prisma/enums.js';

export type PublicUser = { id: string; email: string; role: Role };
export type SessionContext = { ipAddress?: string; userAgent?: string };
export type TokenPair = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: PublicUser;
};
export type AccessTokenClaims = PublicUser;
