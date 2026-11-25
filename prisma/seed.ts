import '@/config/load-env.js';
import { z } from 'zod';
import { hashPassword } from '@/common/security/password.js';
import { loadConfig } from '@/config/env.js';
import { createPrismaClient } from '@/database/client.js';
import { Role } from '@/generated/prisma/enums.js';

const credentials = z
  .object({
    ADMIN_EMAIL: z.string().trim().toLowerCase().pipe(z.email().max(320)),
    ADMIN_PASSWORD: z.string().min(8).max(1024),
  })
  .parse(process.env);

const config = loadConfig();
const database = createPrismaClient(config);

try {
  const passwordHash = await hashPassword(credentials.ADMIN_PASSWORD);
  const user = await database.user.upsert({
    where: { email: credentials.ADMIN_EMAIL },
    create: { email: credentials.ADMIN_EMAIL, passwordHash, role: Role.HQ_ADMIN },
    update: { passwordHash, role: Role.HQ_ADMIN, isActive: true },
    select: { id: true, email: true, role: true },
  });
  process.stdout.write(`Admin seed completed for ${user.email} (${user.id})\n`);
} finally {
  await database.$disconnect();
}
