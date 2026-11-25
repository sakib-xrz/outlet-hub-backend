import type { RequestHandler } from 'express';
import { z } from 'zod';
import { AuthenticationError, BadRequestError } from '@/common/errors/app-error.js';
import type { OutletAccessService } from '@/modules/access/outlet-access.service.js';

const outletIdSchema = z.uuid();

export function requireOutletAccess(
  access: Pick<OutletAccessService, 'assertCanAccessOutlet'>,
  param = 'outletId',
): RequestHandler {
  return async (request, _response, next) => {
    if (!request.user) return next(new AuthenticationError());
    const outletId = outletIdSchema.safeParse(request.params[param]);
    if (!outletId.success) {
      return next(
        new BadRequestError('Validation failed', 'VALIDATION_ERROR', [
          { field: `params.${param}`, message: 'Invalid outlet id' },
        ]),
      );
    }
    try {
      await access.assertCanAccessOutlet(request.user, outletId.data);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}
