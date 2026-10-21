import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  DATABASE_STATS_SQL,
  parseDatabaseStats,
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
  databaseStatsManifest,
} from "./database-stats";

function hasCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code;
}

function statsOutput({ transactions = 7 }: { transactions?: number } = {}) {
  return [
    "0064_example\tschema-value-that-is-ignored",
    "schema\t0064_example",
    "postgres_version_num\t180006",
    "table:accounts\t2",
    "table:attachments\t1",
    `table:transactions\t${transactions}`,
    "table:user_settings\t2",
    "stable:user_settings\t2",
    "",
  ].join("\n");
}

test("all-table statistics use catalog identifiers with PostgreSQL quoting", () => {
  assert.match(DATABASE_STATS_SQL, /FROM pg_catalog\.pg_tables/);
  assert.match(DATABASE_STATS_SQL, /FROM %I\.%I/);
  assert.match(DATABASE_STATS_SQL, /SELECT %L/);
});

test("database statistics preserve schema, server version, and exact table counts", () => {
  const stats = parseDatabaseStats(statsOutput());
  assert.equal(stats.schema, "0064_example");
  assert.equal(stats.postgresVersionNum, 180_006);
  assert.equal(stats.tableCount, 4);
  assert.deepEqual(stats.tableCounts, {
    accounts: 2,
    attachments: 1,
    transactions: 7,
    user_settings: 2,
  });
  assert.equal(stats.transactions, 7);
  assert.deepEqual(databaseStatsManifest(stats).tableCounts, stats.tableCounts);
});

test("database statistics comparison rejects any table row-count drift", () => {
  const expected = parseDatabaseStats(statsOutput());
  const actual = parseDatabaseStats(statsOutput({ transactions: 8 }));
  assert.throws(
    () => assertDatabaseStatsEqual(expected, actual),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});

test("post-start comparison permits runtime cache writes but protects user data", () => {
  const expected = {
    ...parseDatabaseStats(statsOutput()),
    tableCounts: {
      ...parseDatabaseStats(statsOutput()).tableCounts,
      exchange_rates: 10,
    },
  };
  const cacheRefreshed = {
    ...expected,
    tableCounts: { ...expected.tableCounts, exchange_rates: 11 },
  };
  assert.doesNotThrow(() =>
    assertStableDatabaseStatsEqual(expected, cacheRefreshed),
  );

  const userDataChanged = {
    ...expected,
    transactions: 8,
    tableCounts: { ...expected.tableCounts, transactions: 8 },
  };
  assert.throws(
    () => assertStableDatabaseStatsEqual(expected, userDataChanged),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});

test("post-start comparison permits only runtime-managed user settings", () => {
  const expected = parseDatabaseStats(statsOutput());
  const runtimeMarkerInserted = {
    ...expected,
    user_settings: 3,
    tableCounts: { ...expected.tableCounts, user_settings: 3 },
  };
  assert.doesNotThrow(() =>
    assertStableDatabaseStatsEqual(expected, runtimeMarkerInserted),
  );

  const userSettingInserted = {
    ...runtimeMarkerInserted,
    stableImportantRowCounts: {
      ...runtimeMarkerInserted.stableImportantRowCounts,
      user_settings: 3,
    },
  };
  assert.throws(
    () => assertStableDatabaseStatsEqual(expected, userSettingInserted),
    hasCode("DATABASE_COUNT_MISMATCH"),
  );
});

// Runs DATABASE_STATS_SQL against a real PostgreSQL when TEST_DATABASE_URL
// names a disposable, migrated database. Everything happens inside one
// transaction that is rolled back.
test(
  "stable user-settings count ignores daily job markers written after ready",
  { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL not set" },
  () => {
    const run = (settings: string[]) => {
      const values = settings.map((key) => `('${key}')`).join(", ");
      const stdout = execFileSync(
        "psql",
        [
          process.env.TEST_DATABASE_URL ?? "",
          "--tuples-only",
          "--no-align",
          "--field-separator",
          "\t",
          "--quiet",
          "--no-psqlrc",
          "--set",
          "ON_ERROR_STOP=1",
          "--command",
          [
            "BEGIN",
            "DELETE FROM public.user_settings",
            `INSERT INTO public.user_settings(key) VALUES ${values}`,
            DATABASE_STATS_SQL,
            "ROLLBACK",
          ].join(";\n"),
        ],
        { encoding: "utf8" },
      );
      return parseDatabaseStats(stdout);
    };
    const seed = run(["language", "dailyXjobXlookalike"]);
    const afterWarmup = run([
      "language",
      "dailyXjobXlookalike",
      "daily_job_cashflow_forecast",
      "daily_job_fx_refresh",
      "transfers_backfilled",
    ]);
    assert.equal(seed.stableImportantRowCounts.user_settings, 2);
    assert.equal(afterWarmup.stableImportantRowCounts.user_settings, 2);
    assert.equal(afterWarmup.user_settings, 5);
    assert.doesNotThrow(() =>
      assertStableDatabaseStatsEqual(
        { ...seed, tableCounts: afterWarmup.tableCounts },
        afterWarmup,
      ),
    );
    const userSettingAdded = run([
      "language",
      "dailyXjobXlookalike",
      "daily_job_cashflow_forecast",
      "theme",
    ]);
    assert.throws(
      () =>
        assertStableDatabaseStatsEqual(
          { ...seed, tableCounts: userSettingAdded.tableCounts },
          userSettingAdded,
        ),
      hasCode("DATABASE_COUNT_MISMATCH"),
    );
  },
);

test("post-start comparison still rejects schema and table-set drift", () => {
  const expected = parseDatabaseStats(statsOutput());
  assert.throws(
    () =>
      assertStableDatabaseStatsEqual(expected, {
        ...expected,
        tableCounts: { ...expected.tableCounts, runtime_cache: 1 },
      }),
    hasCode("DATABASE_TABLE_SET_MISMATCH"),
  );
  assert.throws(
    () =>
      assertStableDatabaseStatsEqual(expected, {
        ...expected,
        schema: "newer_revision",
      }),
    hasCode("DATABASE_SCHEMA_MISMATCH"),
  );
});
