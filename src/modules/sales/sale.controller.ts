import type { Request, Response } from 'express';
import { AuthenticationError } from '@/common/errors/app-error.js';
import type { AuthenticatedUser } from '@/common/types/http.js';
import { success } from '@/common/types/http.js';
import type { SaleService } from '@/modules/sales/sale.service.js';
import type { CreateSaleInput, SaleListQuery } from '@/modules/sales/sale.types.js';

type OutletParams = { outletId: string };
type SaleParams = { outletId: string; saleId: string };
type RequestParams = { outletId: string; requestId: string };

function currentUser(request: Request): AuthenticatedUser {
  if (!request.user) throw new AuthenticationError();
  return request.user;
}

export class SaleController {
  public constructor(private readonly service: SaleService) {}

  public create = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const { sale, replayed } = await this.service.create(
      currentUser(request),
      request.params.outletId,
      request.validated?.body as CreateSaleInput,
    );
    response
      .status(replayed ? 200 : 201)
      .json(success({ sale, replayed }, replayed ? 'Sale already recorded' : 'Sale completed'));
  };

  public list = async (request: Request<OutletParams>, response: Response): Promise<void> => {
    const result = await this.service.list(
      currentUser(request),
      request.params.outletId,
      request.validated?.query as SaleListQuery,
    );
    response.json(success(result, 'Sales retrieved successfully'));
  };

  public get = async (request: Request<SaleParams>, response: Response): Promise<void> => {
    const { outletId, saleId } = request.params;
    const sale = await this.service.get(currentUser(request), outletId, saleId);
    response.json(success({ sale }, 'Sale retrieved successfully'));
  };

  public getByRequest = async (
    request: Request<RequestParams>,
    response: Response,
  ): Promise<void> => {
    const { outletId, requestId } = request.params;
    const sale = await this.service.getByRequest(currentUser(request), outletId, requestId);
    response.json(success({ sale, replayed: true }, 'Sale found'));
  };
}
