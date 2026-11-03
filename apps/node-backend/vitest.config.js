import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    // Compiles packaging/electron into out/ when stale (ADR-196).
    globalSetup: ["./tests/setup/electronBuild.ts", "./tests/setup/sqliteTemplate.ts"],
    // Each test file gets its own copy of the migrated SQLite template.
    setupFiles: ["./tests/setup/sqliteDatabase.ts"],
    include: [
      "src/**/*.test.{js,ts}",
      "tests/**/*.test.{js,ts}",
    ],
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "json-summary", "json", "html"],
      // Explicit denominator: every source file under src/ counts, whether or
      // not a test happens to import it. Without `include`, v8 only reports on
      // modules loaded during the run, so an entirely untested new service or
      // repository stays invisible and the thresholds silently measure "quality
      // of the files we happen to test" rather than coverage of the codebase.
      //
      // What this gate guarantees: the ratio of src/ lines executed by the
      // Vitest suite. It says nothing about HTTP-level behaviour, so routes
      // count here like any other source file.
      include: ["src/**/*.{js,ts}"],
      exclude: [
        // Test code is never part of the denominator.
        "src/**/*.test.js",
        "tests/**",
        // Process entrypoint: invokes start() at import time and installs
        // process.exit handlers, so it cannot be imported by a unit test.
        "src/main.{js,ts}",
      ],
      // Ratchet gate — tracks current actual coverage so regressions are caught
      // immediately. Bump after each phase adds meaningful tests; never lower
      // these values. Set a 2-3 pt buffer below the measured figure to absorb
      // v8 line-attribution variance between runs (convention: floor(measured)
      // minus 2).
      //
      // Every DB-backed suite runs in every run (each test file has its own
      // SQLite copy, ADR-263), so a local run and CI measure the same figure.
      //
      // Last measured (2026-07-27, PostgreSQL era, before ADR-263):
      //   statements 80.74 % | branches 70.75 % | functions 79.33 % | lines 82.67 %
      thresholds: {
        statements: 78,
        branches: 68,
        functions: 76,
        lines: 80,
      },
    },
  },
});
