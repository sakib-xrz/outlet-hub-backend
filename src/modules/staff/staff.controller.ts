import type { Request, Response } from 'express';
import { success } from '@/common/types/http.js';
import type { StaffService } from '@/modules/staff/staff.service.js';
import type {
  CreateStaffInput,
  ReplaceStaffOutletsInput,
  ResetStaffPasswordInput,
  StaffListQuery,
  UpdateStaffInput,
  UpdateStaffStatusInput,
} from '@/modules/staff/staff.types.js';

type StaffParams = { staffId: string };

export class StaffController {
  public constructor(private readonly service: StaffService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const result = await this.service.list(request.validated?.query as StaffListQuery);
    response.json(success(result, 'Staff retrieved successfully'));
  };

  public get = async (request: Request<StaffParams>, response: Response): Promise<void> => {
    const staff = await this.service.getById(request.params.staffId);
    response.json(success({ staff }, 'Staff member retrieved successfully'));
  };

  public create = async (request: Request, response: Response): Promise<void> => {
    const staff = await this.service.create(request.validated?.body as CreateStaffInput);
    response.status(201).json(success({ staff }, 'Staff member created successfully'));
  };

  public update = async (request: Request<StaffParams>, response: Response): Promise<void> => {
    const { email } = request.validated?.body as UpdateStaffInput;
    const staff = await this.service.updateEmail(request.params.staffId, email);
    response.json(success({ staff }, 'Staff member updated successfully'));
  };

  public setStatus = async (request: Request<StaffParams>, response: Response): Promise<void> => {
    const { isActive } = request.validated?.body as UpdateStaffStatusInput;
    const staff = await this.service.setStatus(request.params.staffId, isActive);
    response.json(success({ staff }, 'Staff status updated successfully'));
  };

  public replaceOutlets = async (
    request: Request<StaffParams>,
    response: Response,
  ): Promise<void> => {
    const { outletIds } = request.validated?.body as ReplaceStaffOutletsInput;
    const staff = await this.service.replaceOutlets(request.params.staffId, outletIds);
    response.json(success({ staff }, 'Outlet assignments updated successfully'));
  };

  public resetPassword = async (
    request: Request<StaffParams>,
    response: Response,
  ): Promise<void> => {
    const { newPassword } = request.validated?.body as ResetStaffPasswordInput;
    await this.service.resetPassword(request.params.staffId, newPassword);
    response.json(success({}, 'Password reset successfully'));
  };
}
