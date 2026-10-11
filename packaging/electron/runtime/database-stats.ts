export const IMPORTANT_TABLES = Object.freeze([
  "accounts",
  "attachments",
  "investments",
  "planned_transactions",
  "portfolio_transactions",
  "recipients",
  "transactions",
  "user_settings",
] as const);

export type ImportantTable = (typeof IMPORTANT_TABLES)[number];

const IMPORTANT_TABLE_NAMES: readonly string[] = IMPORTANT_TABLES;

export const RUNTIME_MANAGED_USER_SETTINGS = Object.freeze([
  "fx_full_history_repair_done",
  "transfers_backfilled",
] as const);

const RUNTIME_MANAGED_USER_SETTINGS_SQL = RUNTIME_MANAGED_USER_SETTINGS.map(
  (key) => `'${key}'`,
).join(", ");

export const DATABASE_STATS_SQL = [
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
   SELECT 'stable:user_settings', count(*)::text
   FROM public.user_settings
   WHERE key NOT IN (${RUNTIME_MANAGED_USER_SETTINGS_SQL})
   UNION ALL
   SELECT 'table:' || table_name, row_count::text
   FROM pg_temp.vision_migration_table_counts
   ORDER BY key`,
].join(";\n");

/** Row counts of the important tables, keyed by table name. */
export type ImportantRowCounts = {
  [Table in ImportantTable]?: number | undefined;
};

export type DatabaseStats = ImportantRowCounts & {
  schema: string;
  postgresVersionNum: number;
  tableCount: number;
  tableCounts: Record<string, number>;
  stableImportantRowCounts: ImportantRowCounts;
};

/** Parsed statistics, or a manifest-derived subset of them, to compare. */
export type ComparableDatabaseStats = Readonly<ImportantRowCounts> & {
  readonly schema?: string | undefined;
  readonly tableCount?: number | undefined;
  readonly tableCounts?: Readonly<Record<string, number>> | undefined;
  readonly stableImportantRowCounts?: Readonly<ImportantRowCounts> | undefined;
};

export interface DatabaseStatsManifest {
  schema: string;
  postgresVersionNum: number;
  tableCount: number;
  tableCounts: Record<string, number>;
  importantRowCounts: ImportantRowCounts;
  stableImportantRowCounts: ImportantRowCounts;
}

type DatabaseStatsError = Error & { code?: string };

function isImportantTable(tableName: string): tableName is ImportantTable {
  return IMPORTANT_TABLE_NAMES.includes(tableName);
}

export function parseDatabaseStats(output: string | undefined): DatabaseStats {
  const tableCounts: Record<string, number> = {};
  const stableImportantRowCounts: ImportantRowCounts = {};
  let schema: string | undefined;
  let postgresVersionNum: number | undefined;
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
    } else if (key.startsWith("stable:")) {
      const tableName = key.slice("stable:".length);
      if (!isImportantTable(tableName)) {
        throw new Error(
          "Database statistics returned an invalid stable table name",
        );
      }
      const count = Number(value);
      if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(
          `Database statistics returned an invalid stable count for ${tableName}`,
        );
      }
      stableImportantRowCounts[tableName] = count;
    }
  }
  if (!schema)
    throw new Error("Database statistics did not return a schema revision");
  if (
    postgresVersionNum === undefined ||
    !Number.isInteger(postgresVersionNum) ||
    postgresVersionNum < 180_000
  ) {
    throw new Error(
      "Database statistics did not return PostgreSQL 18 version data",
    );
  }
  const stats: DatabaseStats = {
    schema,
    postgresVersionNum,
    tableCount: Object.keys(tableCounts).length,
    tableCounts,
    stableImportantRowCounts,
  };
  for (const table of IMPORTANT_TABLES) stats[table] = tableCounts[table];
  return stats;
}

export function assertDatabaseStatsEqual(
  expected: ComparableDatabaseStats,
  actual: ComparableDatabaseStats,
): void {
  assertDatabaseStructureEqual(expected, actual);
  const expectedNames = Object.keys(expected.tableCounts || {}).sort();
  const actualNames = Object.keys(actual.tableCounts || {}).sort();
  if (expectedNames.length > 0 || actualNames.length > 0) {
    for (const table of expectedNames) {
      // Both count maps exist here: the structure check matched their names.
      if (expected.tableCounts?.[table] !== actual.tableCounts?.[table]) {
        const error: DatabaseStatsError = new Error(
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

function assertDatabaseStructureEqual(
  expected: ComparableDatabaseStats,
  actual: ComparableDatabaseStats,
): void {
  if (expected.schema !== actual.schema) {
    const error: DatabaseStatsError = new Error(
      "Database validation schema revision mismatch",
    );
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
      const error: DatabaseStatsError = new Error(
        "Database validation table set mismatch",
      );
      error.code = "DATABASE_TABLE_SET_MISMATCH";
      throw error;
    }
  }
}

function assertImportantDatabaseStatsEqual(
  expected: ComparableDatabaseStats,
  actual: ComparableDatabaseStats,
  { stable = false }: { stable?: boolean } = {},
): void {
  for (const table of IMPORTANT_TABLES) {
    const useStableCount = stable && table === "user_settings";
    const expectedCount = useStableCount
      ? (expected.stableImportantRowCounts?.[table] ?? expected[table])
      : expected[table];
    const actualCount = useStableCount
      ? (actual.stableImportantRowCounts?.[table] ?? actual[table])
      : actual[table];
    if (expectedCount !== actualCount) {
      const error: DatabaseStatsError = new Error(
        `Database validation row count mismatch for ${table}`,
      );
      error.code = "DATABASE_COUNT_MISMATCH";
      throw error;
    }
  }
}

export function assertStableDatabaseStatsEqual(
  expected: ComparableDatabaseStats,
  actual: ComparableDatabaseStats,
): void {
  assertDatabaseStructureEqual(expected, actual);
  assertImportantDatabaseStatsEqual(expected, actual, { stable: true });
}

export function databaseStatsManifest(
  stats: DatabaseStats,
): DatabaseStatsManifest {
  return {
    schema: stats.schema,
    postgresVersionNum: stats.postgresVersionNum,
    tableCount: stats.tableCount,
    tableCounts: stats.tableCounts,
    importantRowCounts: Object.fromEntries(
      IMPORTANT_TABLES.map((table) => [table, stats[table]]),
    ),
    stableImportantRowCounts: stats.stableImportantRowCounts,
  };
}
