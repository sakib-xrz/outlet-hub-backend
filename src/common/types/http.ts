import type { Role } from '@/generated/prisma/enums.js';

export type AuthenticatedUser = {
  id: string;
  email: string;
  role: Role;
};

export type SuccessResponse<T> = {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
};

export function success<T>(data: T, message = 'Operation successful'): SuccessResponse<T> {
  return { success: true, message, data };
}
