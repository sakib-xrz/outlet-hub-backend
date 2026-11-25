import { z } from 'zod';

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    password: z.string().min(8).max(1024),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;
