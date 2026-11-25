import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@/generated/prisma/client.js';
import { AppError, ConflictError, NotFoundError } from '@/common/errors/app-error.js';

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002')
      return new ConflictError('A resource with these values already exists');
    if (error.code === 'P2025') return new NotFoundError();
    return new AppError(500, 'DATABASE_ERROR', 'A database operation failed', undefined, false);
  }
  if (error instanceof SyntaxError && 'status' in error && error.status === 400) {
    return new AppError(400, 'INVALID_JSON', 'Malformed JSON request');
  }
  return new AppError(500, 'INTERNAL_ERROR', 'An unexpected error occurred', undefined, false);
}

export const errorHandler: ErrorRequestHandler = (error, request, response, _next) => {
  const normalized = normalizeError(error);
  const unexpected = !normalized.operational;
  request.log[unexpected ? 'error' : 'warn'](
    { err: error, code: normalized.code, statusCode: normalized.statusCode },
    unexpected ? 'Unexpected request failure' : 'Request failed',
  );

  const message =
    unexpected && process.env.NODE_ENV === 'production'
      ? 'An unexpected error occurred'
      : normalized.message;
  response.status(normalized.statusCode).json({
    success: false,
    message,
    code: normalized.code,
    requestId: request.id,
    ...(normalized.errors ? { errors: normalized.errors } : {}),
  });
};
