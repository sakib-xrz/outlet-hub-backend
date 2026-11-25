import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectDisposableDatabase } from '../../scripts/support/disposable-database.js';

const VARIABLE = 'GUARD_TEST_DATABASE_URL';

afterEach(() => {
  vi.unstubAllEnvs();
});

function arrange(url: string | undefined, confirm = 'yes', application?: string): void {
  vi.stubEnv(VARIABLE, url);
  vi.stubEnv('CONFIRM_DISPOSABLE_DATABASE', confirm);
  vi.stubEnv('DATABASE_URL', application);
}

describe('connectDisposableDatabase refusals', () => {
  it.each([
    ['missing url', undefined, 'yes', undefined, /set GUARD_TEST_DATABASE_URL/],
    [
      'missing confirmation',
      'postgresql://u:p@localhost/outlethub_test',
      'no',
      undefined,
      /CONFIRM_DISPOSABLE_DATABASE/,
    ],
    [
      'remote host',
      'postgresql://u:p@db.example.com/outlethub_test',
      'yes',
      undefined,
      /localhost/,
    ],
    [
      'non-disposable name',
      'postgresql://u:p@localhost/outlethub',
      'yes',
      undefined,
      /database name/,
    ],
    ['not postgres', 'mysql://u:p@localhost/outlethub_test', 'yes', undefined, /PostgreSQL/],
    [
      'same database as DATABASE_URL via another local alias',
      'postgresql://other:x@127.0.0.1:5432/outlethub_test',
      'yes',
      'postgresql://u:p@localhost/outlethub_test',
      /same database/,
    ],
  ])('refuses %s', async (_name, url, confirm, application, message) => {
    arrange(url, confirm, application);
    await expect(connectDisposableDatabase(VARIABLE)).rejects.toThrow(message);
  });
});
