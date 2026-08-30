"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  DATABASE_STATS_SQL,
  parseDatabaseStats,
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
  databaseStatsManifest,
} = require("./database-stats");

function statsOutput({ transactions = 7 } = {}) {
  return [
    "0064_example\tschema-value-that-is-ignored",
    "schema\t0064_example",
    "postgres_version_num\t180006",
    "table:accounts\t2",
    "table:attachments\t1",
    `table:transactions\t${transactions}`,
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
  assert.equal(stats.tableCount, 3);
  assert.deepEqual(stats.tableCounts, {
    accounts: 2,
    attachments: 1,
    transactions: 7,
  });
  assert.equal(stats.transactions, 7);
  assert.deepEqual(databaseStatsManifest(stats).tableCounts, stats.tableCounts);
});

test("database statistics comparison rejects any table row-count drift", () => {
  const expected = parseDatabaseStats(statsOutput());
  const actual = parseDatabaseStats(statsOutput({ transactions: 8 }));
  assert.throws(
    () => assertDatabaseStatsEqual(expected, actual),
    (error) => error.code === "DATABASE_COUNT_MISMATCH",
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
    (error) => error.code === "DATABASE_COUNT_MISMATCH",
  );
});

test("post-start comparison still rejects schema and table-set drift", () => {
  const expected = parseDatabaseStats(statsOutput());
  assert.throws(
    () =>
      assertStableDatabaseStatsEqual(expected, {
        ...expected,
        tableCounts: { ...expected.tableCounts, runtime_cache: 1 },
      }),
    (error) => error.code === "DATABASE_TABLE_SET_MISMATCH",
  );
  assert.throws(
    () =>
      assertStableDatabaseStatsEqual(expected, {
        ...expected,
        schema: "newer_revision",
      }),
    (error) => error.code === "DATABASE_SCHEMA_MISMATCH",
  );
});
