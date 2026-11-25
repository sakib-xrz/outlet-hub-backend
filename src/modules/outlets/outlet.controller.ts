import type { Request, Response } from 'express';
import { AuthenticationError } from '@/common/errors/app-error.js';
import { success } from '@/common/types/http.js';
import type { OutletService } from '@/modules/outlets/outlet.service.js';
import type {
  CreateOutletInput,
  OutletListQuery,
  UpdateOutletInput,
  UpdateOutletStatusInput,
} from '@/modules/outlets/outlet.types.js';

type OutletParams = { outletId: string };

export class OutletController {
  public constructor(private readonly service: OutletService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    if (!request.user) throw new AuthenticationError();
    const query = request.validated?.query as OutletListQuery;
    const result = await this.service.list(request.user, query);
    response.json(success(result, 'Outlets retrieved successfully'));
  };

  public get = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const outlet = await this.service.getById(request.params.outletId);
    response.json(success({ outlet }, 'Outlet retrieved successfully'));
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const outlet = await this.service.create(request.validated?.body as CreateOutletInput);
    response.status(201).json(success({ outlet }, 'Outlet created successfully'));
  };

  public update = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const outlet = await this.service.update(
      request.params.outletId,
      request.validated?.body as UpdateOutletInput,
    );
    response.json(success({ outlet }, 'Outlet updated successfully'));
  };

  public setStatus = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const { isActive } = request.validated?.body as UpdateOutletStatusInput;
    const outlet = await this.service.setStatus(request.params.outletId, isActive);
    response.json(success({ outlet }, 'Outlet status updated successfully'));
  };
}
