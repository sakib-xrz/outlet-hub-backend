import type { Request, Response } from 'express';
import { AuthenticationError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { success } from '@/common/types/http.js';
import type { OutletMenuItemService } from '@/modules/outlet-menu-items/outlet-menu-item.service.js';
import type {
  AssignMenuItemInput,
  OutletMenuListQuery,
  UpdateAssignmentStatusInput,
  UpdateOverridePriceInput,
} from '@/modules/outlet-menu-items/outlet-menu-item.types.js';

type OutletParams = { outletId: string };
type AssignmentParams = { outletId: string; menuItemId: string };

function currentUser(request: Request): AuthenticatedUser {
  if (!request.user) throw new AuthenticationError();
  return request.user;
}

export class OutletMenuItemController {
  public constructor(private readonly service: OutletMenuItemService) {}

  public list = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const result = await this.service.list(
      currentUser(request),
      request.params.outletId,
      request.validated?.query as OutletMenuListQuery,
    );
    response.json(success(result, 'Outlet menu retrieved successfully'));
  };

  public get = async (request: Request<AssignmentParams>, response: Response): Promise<void> => {
    const { outletId, menuItemId } = request.params;
    const outletMenuItem = await this.service.get(currentUser(request), outletId, menuItemId);
    response.json(success({ outletMenuItem }, 'Outlet menu item retrieved successfully'));
  };

  public assign = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const { menuItemId, overridePrice } = request.validated?.body as AssignMenuItemInput;
    const outletMenuItem = await this.service.assign(
      currentUser(request),
      request.params.outletId,
      menuItemId,
      overridePrice,
    );
    response.status(201).json(success({ outletMenuItem }, 'Menu item assigned successfully'));
  };

  public setPrice = async (
    request: Request<AssignmentParams>,
    response: Response,
  ): Promise<void> => {
    const { overridePrice } = request.validated?.body as UpdateOverridePriceInput;
    const { outletId, menuItemId } = request.params;
    const outletMenuItem = await this.service.setOverridePrice(
      currentUser(request),
      outletId,
      menuItemId,
      overridePrice,
    );
    response.json(success({ outletMenuItem }, 'Outlet price updated successfully'));
  };

  public setStatus = async (
    request: Request<AssignmentParams>,
    response: Response,
  ): Promise<void> => {
    const { isActive } = request.validated?.body as UpdateAssignmentStatusInput;
    const { outletId, menuItemId } = request.params;
    const outletMenuItem = await this.service.setStatus(
      currentUser(request),
      outletId,
      menuItemId,
      isActive,
    );
    response.json(success({ outletMenuItem }, 'Assignment status updated successfully'));
  };
}
