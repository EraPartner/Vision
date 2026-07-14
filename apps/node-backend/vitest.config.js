import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.js', 'tests/**/*.test.js', 'tests/**/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      // Only files actually reached by tests. Routes are exercised end-to-end
      // by frontend Playwright suites, not by Vitest, so they stay out — kept
      // out of the coverage denominator explicitly here (route *unit* tests do
      // exist and would otherwise pull large, Playwright-covered route files in
      // and skew the global gate). Test files themselves never count.
      exclude: ['src/routes/**', 'src/**/*.test.js', 'tests/**'],
      thresholds: {
        statements: 85,
        branches: 75,
        functions: 85,
        lines: 88,
      },
    },
  },
});
