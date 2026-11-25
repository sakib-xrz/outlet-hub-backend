import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';

const FILE_ENVIRONMENTS = new Set(['development', 'production']);

export function loadEnvFile(nodeEnv: string = process.env.NODE_ENV ?? 'development'): void {
  if (!FILE_ENVIRONMENTS.has(nodeEnv)) return;
  const path = resolve(process.cwd(), `.env.${nodeEnv}`);
  if (existsSync(path)) config({ path, override: false, quiet: true });
}

loadEnvFile();
