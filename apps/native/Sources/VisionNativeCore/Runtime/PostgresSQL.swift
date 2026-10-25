import Foundation

/// PostgreSQL version parsing, process arguments, configuration and SQL text. Every
/// string here is copied from `packaging/electron/runtime/native.ts`; these are
/// persistence contracts (packaging/AGENTS.md) and must stay identical.
public enum PostgresSQL {
    private static let versionPattern = #"PostgreSQL\)\s+(\d+)(?:\.(\d+))?|PostgreSQL\s+(\d+)(?:\.(\d+))?"#

    /// `parsePostgresMajor`: the major from `postgres (PostgreSQL) 18.6`.
    public static func parseMajor(_ output: String) -> Int? {
        guard let groups = PathUtilities.firstMatchGroups(output, versionPattern, caseInsensitive: true) else {
            return nil
        }
        return (groups[1] ?? groups[3]).flatMap { Int($0) }
    }

    /// `parsePostgresVersionNumber`: `major * 10000 + minor`, like `server_version_num`.
    public static func parseVersionNumber(_ output: String) -> Int? {
        guard let groups = PathUtilities.firstMatchGroups(output, versionPattern, caseInsensitive: true),
            let major = (groups[1] ?? groups[3]).flatMap({ Int($0) })
        else {
            return nil
        }
        let minor = (groups[2] ?? groups[4]).flatMap { Int($0) } ?? 0
        return major * 10_000 + minor
    }

    /// `assertPostgres18Version`.
    @discardableResult
    public static func assertMajor18(_ label: String, _ output: String) throws -> Int {
        let major = parseMajor(output)
        guard major == RuntimeConstants.postgresMajor else {
            throw NativeRuntimeError(
                "POSTGRES_WRONG_VERSION",
                "\(label) must be PostgreSQL \(RuntimeConstants.postgresMajor); found major \(major.map(String.init) ?? "unknown")"
            )
        }
        return RuntimeConstants.postgresMajor
    }

    /// `managedPostgresArgs`: loopback TCP only, Unix sockets disabled.
    public static func serverArguments(dataDirectory: String, port: Int) -> [String] {
        ["-D", dataDirectory, "-h", RuntimeConstants.loopbackHost, "-p", String(port), "-k", ""]
    }

    /// `initdb` arguments for a private cluster (`ensureManagedPostgresCluster`).
    public static func initdbArguments(dataDirectory: String, adminRole: String, passwordFile: String) -> [String] {
        [
            "-D", dataDirectory,
            "--encoding=UTF8",
            "--locale=C",
            "--data-checksums",
            "--auth-local=scram-sha-256",
            "--auth-host=scram-sha-256",
            "--username", adminRole,
            "--pwfile", passwordFile,
        ]
    }

    /// `postgresConfigString`.
    public static func configString(_ value: String) -> String {
        "'\(value.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "''"))'"
    }

    /// `MANAGED_POSTGRES_TUNING` (#353): memory-related settings for the private desktop
    /// cluster. PostgreSQL's defaults size shared memory and background processes for a
    /// server; Vision runs one user with at most about 20 connections (the main pool, the
    /// analysis pools, migrations, role bootstrap and admin psql, pg_dump/pg_restore, with
    /// room for a backend restart overlapping the old one). Every value is a runtime
    /// setting: the data directory format is unchanged and removing a line restores the
    /// default.
    public static let managedTuning = [
        // Default 100. Sizes the per-connection slots and lock table in shared memory.
        "max_connections = 40",
        // PostgreSQL 18 starts 3 I/O worker processes; one serves a single user.
        "io_workers = 1",
        // Default 5000 tracked statements; nothing in the app reads them.
        "pg_stat_statements.max = 1000",
    ]

    /// The managed `vision.conf` (`ensureManagedPostgresConfig`).
    public static func visionConf(port: Int) -> String {
        let base = [
            "listen_addresses = \(configString(RuntimeConstants.loopbackHost))",
            "port = \(port)",
            "unix_socket_directories = ''",
            "password_encryption = 'scram-sha-256'",
            "shared_preload_libraries = 'pg_stat_statements'",
            "logging_collector = off",
        ]
        return (base + managedTuning + [""]).joined(separator: "\n")
    }

    /// The line `postgresql.conf` must contain to load `vision.conf`.
    public static let includeLine = "include = 'vision.conf'"

    public static func includesVisionConf(_ postgresqlConf: String) -> Bool {
        postgresqlConf.split(separator: "\n", omittingEmptySubsequences: false).contains { line in
            PathUtilities.fullMatch(String(line), #"\s*include\s*=\s*'vision\.conf'\s*"#)
        }
    }

    /// `quoteIdentifier`.
    public static func quoteIdentifier(_ value: String) throws -> String {
        let identifier = try validateIdentifier(value, "PostgreSQL identifier")
        return "\"\(identifier)\""
    }

    /// `quoteHexSecret`.
    public static func quoteHexSecret(_ value: String) throws -> String {
        let secret = try requireHexSecret(value)
        return "'\(secret)'"
    }

    /// The SQL of `bootstrapDatabase`, run as the cluster administrator in one psql session
    /// (a process per statement cost about 0.4 s on every launch). It re-asserts the owner
    /// and application roles (created once, password and attributes reset every launch),
    /// the read-only analysis executor, the database owned by the migration owner and, in
    /// that database, the required extensions. `pg_stat_statements` is not trusted, so only
    /// the private cluster administrator installs the extensions; the migration owner stays
    /// a non-superuser. Role administration stays in the desktop runtime.
    public static func bootstrapSQL(_ config: DatabaseConfig) throws -> String {
        func ensureRole(_ role: String) throws -> String {
            let name = try validateIdentifier(role, "PostgreSQL role")
            return
                "SELECT 'CREATE ROLE \(name) NOLOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '\(name)') \\gexec"
        }
        let owner = try quoteIdentifier(config.ownerRole)
        let app = try quoteIdentifier(config.appRole)
        let database = try validateIdentifier(config.database, "database name")
        let quotedDatabase = try quoteIdentifier(database)
        let ownerPassword = try quoteHexSecret(config.ownerPassword)
        let appPassword = try quoteHexSecret(config.appPassword)
        let analysis = RuntimeConstants.analysisRole
        let escapedAnalysisPassword = config.analysisPassword
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "''")
        let analysisPassword = "E'\(escapedAnalysisPassword)'"
        var statements: [String] = [
            try ensureRole(config.ownerRole),
            "ALTER ROLE \(owner) WITH LOGIN PASSWORD \(ownerPassword) NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;",
            try ensureRole(config.appRole),
            "ALTER ROLE \(app) WITH LOGIN PASSWORD \(appPassword) NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;",
            try ensureRole(analysis),
            "ALTER ROLE \(analysis) WITH LOGIN PASSWORD \(analysisPassword) NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;",
            "ALTER ROLE \(analysis) SET default_transaction_read_only = on;",
            "ALTER ROLE \(analysis) SET statement_timeout = '5000ms';",
            "ALTER ROLE \(analysis) SET lock_timeout = '1000ms';",
            "ALTER ROLE \(analysis) SET idle_in_transaction_session_timeout = '5000ms';",
            "ALTER ROLE \(analysis) SET search_path = vision_analysis, pg_catalog;",
            "SELECT 'CREATE DATABASE \(database) OWNER \(owner) TEMPLATE template0' WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = '\(database)') \\gexec",
            "ALTER DATABASE \(quotedDatabase) OWNER TO \(owner);",
            "\\connect \(database)",
        ]
        statements += RuntimeConstants.requiredPostgresExtensions.map { "CREATE EXTENSION IF NOT EXISTS \($0);" }
        return statements.joined(separator: "\n")
    }

    public static func databaseExistsQuery(_ database: String) -> String {
        "SELECT 1 FROM pg_database WHERE datname = '\(database)';"
    }

    public static var createExtensions: String {
        RuntimeConstants.requiredPostgresExtensions
            .map { "CREATE EXTENSION IF NOT EXISTS \($0);" }
            .joined(separator: " ")
    }

    /// `materializedViewOwnershipSql`: the application role owns only the two
    /// runtime-managed materialized views after a no-owner restore.
    public static func materializedViewOwnership(appRole: String) throws -> String {
        let owner = try quoteIdentifier(appRole)
        let schema = try quoteIdentifier("public")
        var statements: [String] = []
        for view in RuntimeConstants.runtimeManagedMaterializedViews {
            let quotedView = try quoteIdentifier(view)
            statements.append("ALTER MATERIALIZED VIEW IF EXISTS \(schema).\(quotedView) OWNER TO \(owner);")
        }
        return statements.joined(separator: "\n")
    }

    public static let inspectServerQuery = "SHOW server_version_num; SHOW listen_addresses; SHOW data_directory;"

    public static func terminateConnections(_ database: String) -> String {
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '\(database)' AND pid <> pg_backend_pid();"
    }

    public static func renameDatabase(_ from: String, to: String) throws -> String {
        let source = try quoteIdentifier(from)
        let destination = try quoteIdentifier(to)
        return "ALTER DATABASE \(source) RENAME TO \(destination);"
    }

    public static func dropDatabase(_ database: String) throws -> String {
        let quoted = try quoteIdentifier(database)
        return "DROP DATABASE \(quoted);"
    }

    /// `validateRestoredDatabase`: the restored database must have public tables.
    public static let publicTableCountQuery =
        "SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"

    /// The ready server must listen on loopback only (`inspectReadyPostgres`).
    public static func isLoopbackOnly(_ listenAddresses: [String]) -> Bool {
        !listenAddresses.isEmpty
            && listenAddresses.allSatisfy { ["localhost", RuntimeConstants.loopbackHost, "::1"].contains($0) }
    }
}
