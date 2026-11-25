import type { RequestHandler } from 'express';
import { AuthenticationError, AuthorizationError } from '@/common/errors/app-error.js';
import type { Role } from '@/generated/prisma/enums.js';
import type { TokenService } from '@/modules/auth/token.service.js';

export function authenticate(tokens: TokenService): RequestHandler {
  return async (request, _response, next) => {
    const authorization = request.header('authorization');
    if (!authorization?.startsWith('Bearer '))
      return next(new AuthenticationError('Access token required'));
    try {
      request.user = await tokens.verifyAccessToken(authorization.slice(7));
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function authorize(...roles: Role[]): RequestHandler {
  const allowed = new Set(roles);
  return (request, _response, next) => {
    if (!request.user) return next(new AuthenticationError());
    if (!allowed.has(request.user.role)) return next(new AuthorizationError());
    return next();
  };
}
