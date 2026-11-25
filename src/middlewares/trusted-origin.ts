import type { RequestHandler } from 'express';
import { AuthorizationError } from '@/common/errors/app-error.js';

export function requireTrustedOrigin(allowedOrigins: readonly string[]): RequestHandler {
  const allowed = new Set(allowedOrigins);
  return (request, _response, next) => {
    const origin = request.header('origin');
    if (!origin || !allowed.has(origin))
      return next(new AuthorizationError('Untrusted request origin'));
    return next();
  };
}
