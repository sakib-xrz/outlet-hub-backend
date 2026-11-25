import { PrismaPg } from '@prisma/adapter-pg';
import type { PoolConfig } from 'pg';
import type { AppConfig } from '@/config/env.js';
import { type Prisma, PrismaClient } from '@/generated/prisma/client.js';

export type DatabaseConfig = Pick<
  AppConfig,
  | 'DATABASE_URL'
  | 'DATABASE_POOL_MAX'
  | 'DATABASE_CONNECTION_TIMEOUT_MS'
  | 'DATABASE_IDLE_TIMEOUT_MS'
>;

export function buildDatabaseOptions(config: DatabaseConfig): {
  pool: PoolConfig;
  schema: string | undefined;
} {
  const url = new URL(config.DATABASE_URL);
  const schema = url.searchParams.get('schema') ?? undefined;
  url.searchParams.delete('schema');

  return {
    pool: {
      connectionString: url.toString(),
      max: config.DATABASE_POOL_MAX,
      connectionTimeoutMillis: config.DATABASE_CONNECTION_TIMEOUT_MS,
      idleTimeoutMillis: config.DATABASE_IDLE_TIMEOUT_MS,
    },
    schema,
  };
}

export function createPrismaClient(config: DatabaseConfig): PrismaClient {
  const { pool, schema } = buildDatabaseOptions(config);
  return new PrismaClient({ adapter: new PrismaPg(pool, schema ? { schema } : undefined) });
}

export type DatabaseClient = PrismaClient;
export type DatabaseExecutor = PrismaClient | Prisma.TransactionClient;
