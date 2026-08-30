"use strict";

const IMPORTANT_TABLES = Object.freeze([
  "accounts",
  "attachments",
  "investments",
  "planned_transactions",
  "portfolio_transactions",
  "recipients",
  "transactions",
  "user_settings",
]);

const DATABASE_STATS_SQL = [
  "CREATE TEMP TABLE vision_migration_table_counts (table_name text PRIMARY KEY, row_count bigint NOT NULL)",
  `DO $vision_table_counts$
   DECLARE item record;
   BEGIN
     FOR item IN
       SELECT schemaname, tablename
       FROM pg_catalog.pg_tables
       WHERE schemaname = 'public'
       ORDER BY tablename
     LOOP
       EXECUTE format(
         'INSERT INTO pg_temp.vision_migration_table_counts(table_name, row_count) SELECT %L, count(*) FROM %I.%I',
         item.tablename,
         item.schemaname,
         item.tablename
       );
     END LOOP;
   END
   $vision_table_counts$`,
  `SELECT 'schema' AS key,
          COALESCE((SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version), '') AS value
   UNION ALL
   SELECT 'postgres_version_num', current_setting('server_version_num')
   UNION ALL
   SELECT 'table:' || table_name, row_count::text
   FROM pg_temp.vision_migration_table_counts
   ORDER BY key`,
].join(";\n");

function parseDatabaseStats(output) {
  const tableCounts = {};
  let schema;
  let postgresVersionNum;
  for (const line of String(output || "").split("\n")) {
    const separator = line.indexOf("\t");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "schema") schema = value;
    else if (key === "postgres_version_num") {
      postgresVersionNum = Number(value);
    } else if (key.startsWith("table:")) {
      const tableName = key.slice("table:".length);
      if (!/^[a-z][a-z0-9_]{0,62}$/.test(tableName)) {
        throw new Error("Database statistics returned an invalid table name");
      }
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `Database statistics returned an invalid count for ${tableName}`,
        );
      }
      tableCounts[tableName] = count;
    }
  }
  if (!schema)
    throw new Error("Database statistics did not return a schema revision");
  if (!Number.isInteger(postgresVersionNum) || postgresVersionNum < 180_000) {
    throw new Error(
      "Database statistics did not return PostgreSQL 18 version data",
    );
  }
  const stats = {
    schema,
    postgresVersionNum,
    tableCount: Object.keys(tableCounts).length,
    tableCounts,
  };
  for (const table of IMPORTANT_TABLES) stats[table] = tableCounts[table];
  return stats;
}

function assertDatabaseStatsEqual(expected, actual) {
  assertDatabaseStructureEqual(expected, actual);
  const expectedNames = Object.keys(expected.tableCounts || {}).sort();
  const actualNames = Object.keys(actual.tableCounts || {}).sort();
  if (expectedNames.length > 0 || actualNames.length > 0) {
    for (const table of expectedNames) {
      if (expected.tableCounts[table] !== actual.tableCounts[table]) {
        const error = new Error(
          `Database validation row count mismatch for ${table}`,
        );
        error.code = "DATABASE_COUNT_MISMATCH";
        throw error;
      }
    }
    return;
  }
  assertImportantDatabaseStatsEqual(expected, actual);
}

function assertDatabaseStructureEqual(expected, actual) {
  if (expected.schema !== actual.schema) {
    const error = new Error("Database validation schema revision mismatch");
    error.code = "DATABASE_SCHEMA_MISMATCH";
    throw error;
  }
  const expectedNames = Object.keys(expected.tableCounts || {}).sort();
  const actualNames = Object.keys(actual.tableCounts || {}).sort();
  if (
    expectedNames.length > 0 ||
    actualNames.length > 0 ||
    expected.tableCount !== undefined ||
    actual.tableCount !== undefined
  ) {
    if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
      const error = new Error("Database validation table set mismatch");
      error.code = "DATABASE_TABLE_SET_MISMATCH";
      throw error;
    }
  }
}

function assertImportantDatabaseStatsEqual(expected, actual) {
  for (const table of IMPORTANT_TABLES) {
    if (expected[table] !== actual[table]) {
      const error = new Error(
        `Database validation row count mismatch for ${table}`,
      );
      error.code = "DATABASE_COUNT_MISMATCH";
      throw error;
    }
  }
}

function assertStableDatabaseStatsEqual(expected, actual) {
  assertDatabaseStructureEqual(expected, actual);
  assertImportantDatabaseStatsEqual(expected, actual);
}

function databaseStatsManifest(stats) {
  return {
    schema: stats.schema,
    postgresVersionNum: stats.postgresVersionNum,
    tableCount: stats.tableCount,
    tableCounts: stats.tableCounts,
    importantRowCounts: Object.fromEntries(
      IMPORTANT_TABLES.map((table) => [table, stats[table]]),
    ),
  };
}

module.exports = {
  IMPORTANT_TABLES,
  DATABASE_STATS_SQL,
  parseDatabaseStats,
  assertDatabaseStatsEqual,
  assertStableDatabaseStatsEqual,
  databaseStatsManifest,
};
