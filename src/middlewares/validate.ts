import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { BadRequestError } from '@/common/errors/app-error.js';

type RequestSchemas = { body?: ZodType; params?: ZodType; query?: ZodType };

export function validate(schemas: RequestSchemas): RequestHandler {
  return (request, _response, next) => {
    for (const [key, schema] of Object.entries(schemas) as [keyof RequestSchemas, ZodType][]) {
      const result = schema.safeParse(request[key]);
      if (!result.success) {
        const errors = result.error.issues.map((issue) => ({
          field: [key, ...issue.path].join('.'),
          message: issue.message,
        }));
        return next(new BadRequestError('Validation failed', 'VALIDATION_ERROR', errors));
      }
      if (key !== 'query') Object.assign(request[key] as object, result.data);
      request.validated = { ...request.validated, [key]: result.data };
    }
    return next();
  };
}
