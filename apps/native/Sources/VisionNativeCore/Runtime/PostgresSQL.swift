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

    /// The managed `vision.conf` (`ensureManagedPostgresConfig`).
    public static func visionConf(port: Int) -> String {
        [
            "listen_addresses = \(configString(RuntimeConstants.loopbackHost))",
            "port = \(port)",
            "unix_socket_directories = ''",
            "password_encryption = 'scram-sha-256'",
            "shared_preload_libraries = 'pg_stat_statements'",
            "logging_collector = off",
            "",
        ].joined(separator: "\n")
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

    public static func createLoginRole(_ role: String, password: String) throws -> String {
        let quotedRole = try quoteIdentifier(role)
        let quotedPassword = try quoteHexSecret(password)
        return "CREATE ROLE \(quotedRole) LOGIN PASSWORD \(quotedPassword) NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;"
    }

    public static func alterLoginRole(_ role: String, password: String) throws -> String {
        let quotedRole = try quoteIdentifier(role)
        let quotedPassword = try quoteHexSecret(password)
        return "ALTER ROLE \(quotedRole) WITH LOGIN PASSWORD \(quotedPassword) NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;"
    }

    public static func roleExistsQuery(_ role: String) -> String {
        "SELECT 1 FROM pg_roles WHERE rolname = '\(role.replacingOccurrences(of: "'", with: "''"))';"
    }

    public static func databaseExistsQuery(_ database: String) -> String {
        "SELECT 1 FROM pg_database WHERE datname = '\(database)';"
    }

    public static var createAnalysisRole: String {
        "CREATE ROLE \(RuntimeConstants.analysisRole) NOLOGIN;"
    }

    /// The analysis executor's login and read-only defaults, reset on every bootstrap.
    public static func configureAnalysisRole(password: String) -> String {
        let role = RuntimeConstants.analysisRole
        let literal = "E'\(password.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "''"))'"
        return [
            "ALTER ROLE \(role) WITH LOGIN PASSWORD \(literal) NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;",
            "ALTER ROLE \(role) SET default_transaction_read_only = on;",
            "ALTER ROLE \(role) SET statement_timeout = '5000ms';",
            "ALTER ROLE \(role) SET lock_timeout = '1000ms';",
            "ALTER ROLE \(role) SET idle_in_transaction_session_timeout = '5000ms';",
            "ALTER ROLE \(role) SET search_path = vision_analysis, pg_catalog;",
        ].joined(separator: "\n")
    }

    public static func alterDatabaseOwner(_ database: String, owner: String) throws -> String {
        let quotedDatabase = try quoteIdentifier(database)
        let quotedOwner = try quoteIdentifier(owner)
        return "ALTER DATABASE \(quotedDatabase) OWNER TO \(quotedOwner);"
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

    public static let restoredDatabaseQuery =
        "SELECT version_num FROM alembic_version ORDER BY version_num; SELECT count(*) FROM pg_catalog.pg_tables WHERE schemaname = 'public';"

    /// The ready server must listen on loopback only (`inspectReadyPostgres`).
    public static func isLoopbackOnly(_ listenAddresses: [String]) -> Bool {
        !listenAddresses.isEmpty
            && listenAddresses.allSatisfy { ["localhost", RuntimeConstants.loopbackHost, "::1"].contains($0) }
    }
}
