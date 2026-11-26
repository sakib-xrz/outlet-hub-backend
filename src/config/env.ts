import { z } from 'zod';

const booleanFromString = z.enum(['true', 'false']).transform((value) => value === 'true');

const optionalString = z
  .string()
  .transform((value) => value.trim() || undefined)
  .optional();

const schema = z
  .object({
    NODE_ENV: z.enum(['development', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8000),
    TRUST_PROXY: z.coerce.number().int().min(0).max(10).default(0),
    REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(15_000),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60_000).default(10_000),
    BODY_LIMIT: z
      .string()
      .regex(/^\d+(?:kb|mb)$/i)
      .default('100kb'),
    DATABASE_URL: z.url().regex(/^postgres(?:ql)?:\/\//, 'must be a PostgreSQL connection URL'),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    DATABASE_CONNECTION_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(5_000),
    DATABASE_IDLE_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(10_000),
    DATABASE_HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(2_000),
    JWT_SECRET: z.string().min(32),
    JWT_ISSUER: z.string().min(1).default('outlet-hub'),
    JWT_AUDIENCE: z.string().min(1).default('outlet-hub-web'),
    JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
    REFRESH_TOKEN_TTL_SECONDS: z.coerce.number().int().min(3600).max(7_776_000).default(2_592_000),
    REFRESH_COOKIE_NAME: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .default('outlethub_refresh'),
    COOKIE_SECURE: booleanFromString.default(false),
    COOKIE_SAME_SITE: z.enum(['strict', 'lax', 'none']).default('strict'),
    COOKIE_DOMAIN: optionalString,
    ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .transform((value, context) => {
        const origins = [
          ...new Set(
            value
              .split(',')
              .map((entry) => entry.trim())
              .filter(Boolean),
          ),
        ];
        for (const origin of origins) {
          try {
            const url = new URL(origin);
            if (url.origin !== origin || !['http:', 'https:'].includes(url.protocol))
              throw new Error();
          } catch {
            context.addIssue({ code: 'custom', message: `Invalid exact origin: ${origin}` });
          }
        }
        return origins;
      }),
    GLOBAL_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    GLOBAL_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
    AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900_000),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFromString.default(false),
    SWAGGER_ENABLED: booleanFromString.default(false),
  })
  .superRefine((env, context) => {
    if (env.COOKIE_SAME_SITE === 'none' && !env.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true when SameSite=None',
      });
    }
    if (env.NODE_ENV === 'production' && !env.COOKIE_SECURE) {
      context.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'must be true in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.JWT_SECRET.includes('replace')) {
      context.addIssue({
        code: 'custom',
        path: ['JWT_SECRET'],
        message: 'must not be a placeholder',
      });
    }
  });

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = schema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  return result.data;
}
