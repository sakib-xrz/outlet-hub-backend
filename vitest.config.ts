import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    environment: 'node',
    env: { DATABASE_URL: 'postgresql://unit-tests:no-database@127.0.0.1:9/none' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/server.ts'],
    },
  },
});
