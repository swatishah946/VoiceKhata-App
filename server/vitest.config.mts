import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    // Integration tests share one database, so run files one after another
    fileParallelism: false,
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/index.ts'],
      reporter: ['text', 'json-summary', 'html'],
      // CI fails if coverage drops below these (current: ~94% statements, ~96% lines)
      thresholds: { statements: 90, branches: 80, functions: 90, lines: 92 },
    },
  },
});
