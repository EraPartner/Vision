import Foundation

/// Database statistics used to verify a restored Demo seed, ported from
/// `packaging/electron/runtime/database-stats.ts`.
public enum DatabaseStatistics {
    public static let importantTables = [
        "accounts", "attachments", "investments", "planned_transactions", "portfolio_transactions", "recipients",
        "transactions", "user_settings",
    ]
    public static let runtimeManagedUserSettings = ["fx_full_history_repair_done", "transfers_backfilled"]

    /// `DATABASE_STATS_SQL`, character for character.
    public static let sql: String = [
        "CREATE TEMP TABLE vision_migration_table_counts (table_name text PRIMARY KEY, row_count bigint NOT NULL)",
        """
        DO $vision_table_counts$
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
           $vision_table_counts$
        """,
        """
        SELECT 'schema' AS key,
                  COALESCE((SELECT string_agg(version_num, ',' ORDER BY version_num) FROM alembic_version), '') AS value
           UNION ALL
           SELECT 'postgres_version_num', current_setting('server_version_num')
           UNION ALL
           SELECT 'stable:user_settings', count(*)::text
           FROM public.user_settings
           WHERE key NOT IN (\(runtimeManagedUserSettings.map { "'\($0)'" }.joined(separator: ", ")))
           UNION ALL
           SELECT 'table:' || table_name, row_count::text
           FROM pg_temp.vision_migration_table_counts
           ORDER BY key
        """,
    ].joined(separator: ";\n")

    /// `parseDatabaseStats`: `key<TAB>value` rows from `psql --tuples-only --no-align`.
    public static func parse(_ output: String) throws -> DatabaseStats {
        var tableCounts: [String: Int] = [:]
        var stable: [String: Int] = [:]
        var schema: String?
        var postgresVersionNum: Int?
        for line in output.split(separator: "\n", omittingEmptySubsequences: false) {
            guard let separator = line.firstIndex(of: "\t"), separator > line.startIndex else { continue }
            let key = line[..<separator].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = line[line.index(after: separator)...].trimmingCharacters(in: .whitespacesAndNewlines)
            if key == "schema" {
                schema = value
            } else if key == "postgres_version_num" {
                postgresVersionNum = Int(value)
            } else if key.hasPrefix("table:") {
                let table = String(key.dropFirst("table:".count))
                guard PathUtilities.fullMatch(table, "[a-z][a-z0-9_]{0,62}") else {
                    throw NativeRuntimeError(
                        "DATABASE_STATS_INVALID", "Database statistics returned an invalid table name")
                }
                guard let count = Int(value), count >= 0 else {
                    throw NativeRuntimeError(
                        "DATABASE_STATS_INVALID", "Database statistics returned an invalid count for \(table)")
                }
                tableCounts[table] = count
            } else if key.hasPrefix("stable:") {
                let table = String(key.dropFirst("stable:".count))
                guard importantTables.contains(table) else {
                    throw NativeRuntimeError(
                        "DATABASE_STATS_INVALID", "Database statistics returned an invalid stable table name")
                }
                guard let count = Int(value), count >= 0 else {
                    throw NativeRuntimeError(
                        "DATABASE_STATS_INVALID",
                        "Database statistics returned an invalid stable count for \(table)")
                }
                stable[table] = count
            }
        }
        guard let schema, !schema.isEmpty else {
            throw NativeRuntimeError("DATABASE_STATS_INVALID", "Database statistics did not return a schema revision")
        }
        guard let postgresVersionNum, postgresVersionNum >= 180_000 else {
            throw NativeRuntimeError(
                "DATABASE_STATS_INVALID", "Database statistics did not return PostgreSQL 18 version data")
        }
        return DatabaseStats(
            schema: schema,
            postgresVersionNum: postgresVersionNum,
            tableCounts: tableCounts,
            stableImportantRowCounts: stable
        )
    }

    private static func mismatch(_ code: String, _ message: String) -> NativeRuntimeError {
        NativeRuntimeError(code, message)
    }

    /// `assertDatabaseStatsEqual`: schema, complete table set and every exact count
    /// (or the important tables when neither side lists tables).
    public static func assertEqual(expected: ComparableDatabaseStats, actual: ComparableDatabaseStats) throws {
        try assertStructureEqual(expected: expected, actual: actual)
        let expectedNames = (expected.tableCounts ?? [:]).keys.sorted()
        let actualNames = (actual.tableCounts ?? [:]).keys.sorted()
        if !expectedNames.isEmpty || !actualNames.isEmpty {
            for table in expectedNames where expected.tableCounts?[table] != actual.tableCounts?[table] {
                throw mismatch("DATABASE_COUNT_MISMATCH", "Database validation row count mismatch for \(table)")
            }
            return
        }
        try assertImportantEqual(expected: expected, actual: actual, stable: false)
    }

    /// `assertStableDatabaseStatsEqual`: structure plus the important tables, using the
    /// user-settings count without runtime-owned maintenance markers.
    public static func assertStableEqual(expected: ComparableDatabaseStats, actual: ComparableDatabaseStats) throws {
        try assertStructureEqual(expected: expected, actual: actual)
        try assertImportantEqual(expected: expected, actual: actual, stable: true)
    }

    private static func assertStructureEqual(expected: ComparableDatabaseStats, actual: ComparableDatabaseStats)
        throws
    {
        guard expected.schema == actual.schema else {
            throw mismatch("DATABASE_SCHEMA_MISMATCH", "Database validation schema revision mismatch")
        }
        let expectedNames = (expected.tableCounts ?? [:]).keys.sorted()
        let actualNames = (actual.tableCounts ?? [:]).keys.sorted()
        if !expectedNames.isEmpty || !actualNames.isEmpty || expected.tableCount != nil || actual.tableCount != nil {
            guard expectedNames == actualNames else {
                throw mismatch("DATABASE_TABLE_SET_MISMATCH", "Database validation table set mismatch")
            }
        }
    }

    private static func assertImportantEqual(
        expected: ComparableDatabaseStats,
        actual: ComparableDatabaseStats,
        stable: Bool
    ) throws {
        for table in importantTables {
            let useStable = stable && table == "user_settings"
            let expectedCount =
                useStable
                ? (expected.stableImportantRowCounts?[table] ?? expected.important[table]) : expected.important[table]
            let actualCount =
                useStable
                ? (actual.stableImportantRowCounts?[table] ?? actual.important[table]) : actual.important[table]
            if expectedCount != actualCount {
                throw mismatch("DATABASE_COUNT_MISMATCH", "Database validation row count mismatch for \(table)")
            }
        }
    }
}

/// Parsed statistics of a live database (`DatabaseStats`).
public struct DatabaseStats: Sendable, Equatable {
    public let schema: String
    public let postgresVersionNum: Int
    public let tableCounts: [String: Int]
    public let stableImportantRowCounts: [String: Int]

    public var tableCount: Int { tableCounts.count }

    /// The comparable view, with the important tables read from the table counts.
    public var comparable: ComparableDatabaseStats {
        var important: [String: JSONValue] = [:]
        for table in DatabaseStatistics.importantTables {
            if let count = tableCounts[table] { important[table] = .int(count) }
        }
        return ComparableDatabaseStats(
            schema: .string(schema),
            tableCount: .int(tableCount),
            tableCounts: tableCounts.mapValues { .int($0) },
            important: important,
            stableImportantRowCounts: stableImportantRowCounts.mapValues { .int($0) }
        )
    }
}

/// Statistics in comparable form (`ComparableDatabaseStats`). Values stay JSON values so
/// a mistyped manifest field fails as a mismatch, like the strict `!==` comparisons.
public struct ComparableDatabaseStats: Sendable, Equatable {
    public var schema: JSONValue?
    public var tableCount: JSONValue?
    public var tableCounts: [String: JSONValue]?
    /// Counts of `importantTables`, keyed by table.
    public var important: [String: JSONValue]
    public var stableImportantRowCounts: [String: JSONValue]?

    public init(
        schema: JSONValue?,
        tableCount: JSONValue?,
        tableCounts: [String: JSONValue]?,
        important: [String: JSONValue],
        stableImportantRowCounts: [String: JSONValue]?
    ) {
        self.schema = schema
        self.tableCount = tableCount
        self.tableCounts = tableCounts
        self.important = important
        self.stableImportantRowCounts = stableImportantRowCounts
    }

    /// `comparableManifestStats`: the seed manifest's `database` object, with its
    /// `importantRowCounts` taking precedence for the important tables.
    public init(manifestDatabase database: JSONValue) {
        var important: [String: JSONValue] = [:]
        for table in DatabaseStatistics.importantTables {
            if let value = database[table] { important[table] = value }
            if let value = database["importantRowCounts"]?[table] { important[table] = value }
        }
        // `{ ...database, ...importantRowCounts }`: the spread can also replace these keys.
        let overrides = database["importantRowCounts"]?.objectValue ?? [:]
        self.init(
            schema: overrides["schema"] ?? database["schema"],
            tableCount: overrides["tableCount"] ?? database["tableCount"],
            tableCounts: (overrides["tableCounts"] ?? database["tableCounts"])?.objectValue,
            important: important,
            stableImportantRowCounts: (overrides["stableImportantRowCounts"] ?? database["stableImportantRowCounts"])?
                .objectValue
        )
    }
}
