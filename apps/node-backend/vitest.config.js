import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.js', 'tests/**/*.test.js', 'tests/**/**/*.test.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'json', 'html'],
      // Explicit denominator: every source file under src/ counts, whether or
      // not a test happens to import it. Without `include`, v8 only reports on
      // modules loaded during the run, so an entirely untested new service or
      // repository stays invisible and the thresholds silently measure "quality
      // of the files we happen to test" rather than coverage of the codebase.
      //
      // What this gate guarantees: the ratio of src/ lines executed by the
      // Vitest suite. It says nothing about HTTP-level behaviour — the frontend
      // Playwright suite is page-load smoke, dialog UX, a11y scans and a handful
      // of CRUD writes, not route coverage, so routes are counted here like any
      // other source file rather than being waved through as "covered by e2e".
      include: ['src/**/*.js'],
      exclude: [
        // Test code is never part of the denominator.
        'src/**/*.test.js',
        'tests/**',
        // Process entrypoint: invokes start() at import time and installs
        // process.exit handlers, so it cannot be imported by a unit test.
        'src/main.js',
        // Migration glue: execFile()s the alembic CLI against a live database
        // and a Python toolchain; exercised by migration runs, not by Vitest.
        'src/database/migrate.js',
      ],
      // Ratchet gate — tracks current actual coverage so regressions are caught
      // immediately. Bump after each phase adds meaningful tests; never lower
      // these values. Set a 2-3 pt buffer below the measured figure to absorb
      // v8 line-attribution variance between runs (convention: floor(measured)
      // minus 2).
      //
      // Coverage now depends on whether TEST_DATABASE_URL is set: the DB-backed
      // suites (tests/setup/db.js seam) skip without it, so a plain local run
      // measures LOWER than CI, which always has the Postgres service. Always
      // set these thresholds from the no-DB figure — deriving them from a CI
      // number would leave `bun vitest run --coverage` failing on any machine
      // without a database.
      //
      // Last measured (2026-07-27, 3.1k-test suite, with the include list above):
      //   without TEST_DATABASE_URL (the figure the thresholds track):
      //     statements 80.52 % | branches 70.62 % | functions 78.97 % | lines 82.45 %
      //   with TEST_DATABASE_URL (CI):
      //     statements 80.74 % | branches 70.75 % | functions 79.33 % | lines 82.67 %
      thresholds: {
        statements: 78,
        branches: 68,
        functions: 76,
        lines: 80,
      },
    },
  },
});
