import { createPrismaClient, type DatabaseClient } from '@/database/client.js';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DISPOSABLE_NAME = /(test|verify|verification|disposable|scratch)/i;
export const FIXTURE_EMAIL_DOMAIN = '@example.invalid';
export const FIXTURE_CODE_PREFIX = 'VERIFY-';

type Target = { host: string; port: string; database: string };

function parse(value: string, label: string): Target {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Refusing to run: ${label} is not a valid URL.`);
  }
  if (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') {
    throw new Error(`Refusing to run: ${label} is not a PostgreSQL URL.`);
  }
  return {
    host: url.hostname.toLowerCase(),
    port: url.port || '5432',
    database: decodeURIComponent(url.pathname.replace(/^\//, '')),
  };
}

function refuse(reason: string): never {
  throw new Error(`Refusing to run: ${reason}`);
}

export async function connectDisposableDatabase(variable: string): Promise<DatabaseClient> {
  const value = process.env[variable];
  if (!value || process.env.CONFIRM_DISPOSABLE_DATABASE !== 'yes') {
    refuse(
      `set ${variable} to a local, migrated, disposable database and CONFIRM_DISPOSABLE_DATABASE=yes.`,
    );
  }
  const target = parse(value, variable);
  if (!LOCAL_HOSTS.has(target.host)) {
    refuse(`${variable} must point to localhost; remote and shared databases are never used.`);
  }
  if (!DISPOSABLE_NAME.test(target.database)) {
    refuse('the database name must contain test, verify, verification, disposable or scratch.');
  }
  const application = process.env.DATABASE_URL;
  if (application) {
    const configured = parse(application, 'DATABASE_URL');
    if (
      configured.database === target.database &&
      configured.port === target.port &&
      (configured.host === target.host ||
        (LOCAL_HOSTS.has(configured.host) && LOCAL_HOSTS.has(target.host)))
    ) {
      refuse(`${variable} resolves to the same database as DATABASE_URL.`);
    }
  }

  const database = createPrismaClient({
    DATABASE_URL: value,
    DATABASE_POOL_MAX: 25,
    DATABASE_CONNECTION_TIMEOUT_MS: 15_000,
    DATABASE_IDLE_TIMEOUT_MS: 10_000,
  });
  try {
    const [identity] = await database.$queryRaw<
      { name: string }[]
    >`SELECT current_database() AS name`;
    if (identity?.name !== target.database) refuse('connected to an unexpected database.');
    const [foreign] = await database.$queryRaw<{ users: number; outlets: number }[]>`
      SELECT
        (SELECT COUNT(*)::int FROM users WHERE email NOT LIKE ${`%${FIXTURE_EMAIL_DOMAIN}`}) AS users,
        (SELECT COUNT(*)::int FROM outlets WHERE code NOT LIKE ${`${FIXTURE_CODE_PREFIX}%`}) AS outlets`;
    if ((foreign?.users ?? 0) > 0 || (foreign?.outlets ?? 0) > 0) {
      refuse('the database contains users or outlets that these scripts did not create.');
    }
    return database;
  } catch (error) {
    await database.$disconnect();
    throw error;
  }
}
