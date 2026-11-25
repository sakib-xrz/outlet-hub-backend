import type { Request, Response } from 'express';
import { AuthenticationError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { success } from '@/common/types/http.js';
import type { InventoryService } from '@/modules/inventory/inventory.service.js';
import type { InventoryListQuery, StockAdjustment } from '@/modules/inventory/inventory.types.js';

type OutletParams = { outletId: string };
type ItemParams = { outletId: string; menuItemId: string };

function currentUser(request: Request): AuthenticatedUser {
  if (!request.user) throw new AuthenticationError();
  return request.user;
}

export class InventoryController {
  public constructor(private readonly service: InventoryService) {}

  public list = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const result = await this.service.list(
      currentUser(request),
      request.params.outletId,
      request.validated?.query as InventoryListQuery,
    );
    response.json(success(result, 'Inventory retrieved successfully'));
  };

  public get = async (request: Request<ItemParams>, response: Response): Promise<void> => {
    const { outletId, menuItemId } = request.params;
    const inventoryItem = await this.service.get(currentUser(request), outletId, menuItemId);
    response.json(success({ inventoryItem }, 'Inventory item retrieved successfully'));
  };

  public adjust = async (request: Request<ItemParams>, response: Response): Promise<void> => {
    const { outletId, menuItemId } = request.params;
    const result = await this.service.adjust(
      currentUser(request),
      outletId,
      menuItemId,
      request.validated?.body as StockAdjustment,
    );
    response.json(success(result, 'Stock adjusted successfully'));
  };
}
