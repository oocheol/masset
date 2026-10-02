import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['packages/**/*.test.{ts,tsx,js,mjs}', 'apps/**/*.test.{ts,tsx,js,mjs}', 'tests/artifact/**/*.test.{ts,js,mjs}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/target/**', 'tests/e2e/**'],
    testTimeout: 20_000,
    restoreMocks: true,
  },
});
