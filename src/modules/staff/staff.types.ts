import type { z } from 'zod';
import type { Role } from '@/generated/prisma/enums.js';
import type {
  createStaffSchema,
  replaceStaffOutletsSchema,
  resetStaffPasswordSchema,
  staffListQuerySchema,
  updateStaffSchema,
  updateStaffStatusSchema,
} from '@/modules/staff/staff.validation.js';

export type StaffIdentity = {
  id: string;
  email: string;
  role: Role;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

export type StaffSummary = StaffIdentity & { outletCount: number };

export type StaffOutlet = { id: string; code: string; name: string; isActive: boolean };

export type StaffDetail = StaffIdentity & { outlets: StaffOutlet[] };

export type StaffListQuery = z.infer<typeof staffListQuerySchema>;
export type CreateStaffInput = z.infer<typeof createStaffSchema>;
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;
export type UpdateStaffStatusInput = z.infer<typeof updateStaffStatusSchema>;
export type ReplaceStaffOutletsInput = z.infer<typeof replaceStaffOutletsSchema>;
export type ResetStaffPasswordInput = z.infer<typeof resetStaffPasswordSchema>;

export type OutletCheckResult = { kind: 'ok' } | { kind: 'invalid-outlets'; outletIds: string[] };
