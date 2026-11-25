import type { Request, Response } from 'express';
import { success } from '@/common/types/http.js';
import type { MenuItemService } from '@/modules/menu-items/menu-item.service.js';
import type {
  CreateMenuItemInput,
  MenuItemListQuery,
  UpdateMenuItemInput,
  UpdateMenuItemStatusInput,
} from '@/modules/menu-items/menu-item.types.js';

type MenuItemParams = { menuItemId: string };

export class MenuItemController {
  public constructor(private readonly service: MenuItemService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const result = await this.service.list(request.validated?.query as MenuItemListQuery);
    response.json(success(result, 'Menu items retrieved successfully'));
  };

  public get = async (request: Request<MenuItemParams>, response: Response): Promise<void> => {
    const menuItem = await this.service.getById(request.params.menuItemId);
    response.json(success({ menuItem }, 'Menu item retrieved successfully'));
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const menuItem = await this.service.create(request.validated?.body as CreateMenuItemInput);
    response.status(201).json(success({ menuItem }, 'Menu item created successfully'));
  };

  public update = async (request: Request<MenuItemParams>, response: Response): Promise<void> => {
    const menuItem = await this.service.update(
      request.params.menuItemId,
      request.validated?.body as UpdateMenuItemInput,
    );
    response.json(success({ menuItem }, 'Menu item updated successfully'));
  };

  public setStatus = async (
    request: Request<MenuItemParams>,
    response: Response,
  ): Promise<void> => {
    const { isActive } = request.validated?.body as UpdateMenuItemStatusInput;
    const menuItem = await this.service.setStatus(request.params.menuItemId, isActive);
    response.json(success({ menuItem }, 'Menu item status updated successfully'));
  };
}
