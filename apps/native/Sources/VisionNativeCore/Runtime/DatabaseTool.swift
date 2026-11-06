import Foundation

/// What `tools/db-file.js` prints for a database it checked or wrote (`DatabaseFileReport`
/// in `packaging/electron/runtime/native.ts`).
public struct DatabaseFileReport: Sendable, Equatable {
    public let file: String
    public let bytes: Int
    public let sha256: String
    public let sqliteVersion: String
    /// Latest migration version recorded in the database's ledger.
    public let schemaVersion: Int
    /// Migrations this build would still apply when the backend opens it.
    public let pendingMigrations: Int
    /// Rows per table; only `create` reports them.
    public let tableCounts: [String: Int]?

    public init(
        file: String, bytes: Int, sha256: String, sqliteVersion: String, schemaVersion: Int,
        pendingMigrations: Int, tableCounts: [String: Int]? = nil
    ) {
        self.file = file
        self.bytes = bytes
        self.sha256 = sha256
        self.sqliteVersion = sqliteVersion
        self.schemaVersion = schemaVersion
        self.pendingMigrations = pendingMigrations
        self.tableCounts = tableCounts
    }

    /// The same report for another path (`{ ...report, file }`).
    public func at(_ path: String) -> DatabaseFileReport {
        DatabaseFileReport(
            file: path, bytes: bytes, sha256: sha256, sqliteVersion: sqliteVersion, schemaVersion: schemaVersion,
            pendingMigrations: pendingMigrations, tableCounts: tableCounts)
    }
}

/// The result line of a database tool run.
public enum DatabaseToolOutcome: Sendable, Equatable {
    case report(DatabaseFileReport)
    case failure(String)
}

/// The packaged database tool's commands and output (`databaseToolCommand`,
/// `parseDatabaseToolOutput`).
public enum DatabaseTool {
    /// `verify <file>`: `integrity_check`, `foreign_key_check` and the migration ledger.
    case verify(String)
    /// `snapshot <source> <destination>`: a consistent copy (`VACUUM INTO`), verified.
    case snapshot(source: String, destination: String)
    /// `create <file> [seed.sql]`: a new database at the packaged migration head.
    case create(String, seedSQL: String?)

    public var arguments: [String] {
        switch self {
        case .verify(let file): return ["verify", file]
        case .snapshot(let source, let destination): return ["snapshot", source, destination]
        case .create(let file, let seed): return ["create", file] + (seed.map { [$0] } ?? [])
        }
    }

    /// The error code a failure carries (`runDatabaseTool`'s `code`).
    public var failureCode: String {
        switch self {
        case .verify: return "DATABASE_VERIFY_FAILED"
        case .snapshot: return "DATABASE_SNAPSHOT_FAILED"
        case .create: return "DATABASE_CREATE_FAILED"
        }
    }

    private static func count(_ value: JSONValue?) -> Int? {
        guard let number = value?.intValue, number >= 0 else { return nil }
        return number
    }

    private static func invalid(_ message: String) -> NativeRuntimeError {
        NativeRuntimeError("DATABASE_TOOL_INVALID", message)
    }

    private static func tableCounts(_ value: JSONValue?) throws -> [String: Int]? {
        guard let value else { return nil }
        guard let object = value.objectValue else { throw invalid("The database tool reported invalid table counts") }
        var counts: [String: Int] = [:]
        for (table, raw) in object {
            guard PathUtilities.fullMatch(table, "[a-z][a-z0-9_]{0,62}"), let rows = count(raw) else {
                throw invalid("The database tool reported invalid table counts")
            }
            counts[table] = rows
        }
        return counts
    }

    /// `parseDatabaseToolOutput`: the last stdout line that is a JSON object with a boolean
    /// `ok` (the backend logger may print lines before it); `nil` when there is none. A
    /// success line without every report field throws.
    public static func parseOutput(_ stdout: String) throws -> DatabaseToolOutcome? {
        let lines = stdout.split(separator: "\n", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
        for line in lines.reversed() where line.hasPrefix("{") {
            guard let parsed = try? JSONValue.parse(Data(line.utf8)), parsed.objectValue != nil,
                case .bool(let ok)? = parsed["ok"]
            else { continue }
            guard ok else {
                let message = parsed["error"]?.stringValue ?? ""
                return .failure(message.isEmpty ? "The database tool failed" : message)
            }
            guard let file = parsed["file"]?.stringValue,
                let bytes = count(parsed["bytes"]),
                let sha256 = parsed["sha256"]?.stringValue, PathUtilities.isSHA256(sha256),
                let sqliteVersion = parsed["sqliteVersion"]?.stringValue,
                let schemaVersion = count(parsed["schemaVersion"]),
                let pending = count(parsed["pendingMigrations"])
            else {
                throw invalid("The database tool returned an invalid report")
            }
            return .report(
                DatabaseFileReport(
                    file: file, bytes: bytes, sha256: sha256, sqliteVersion: sqliteVersion,
                    schemaVersion: schemaVersion, pendingMigrations: pending,
                    tableCounts: try tableCounts(parsed["tableCounts"])))
        }
        return nil
    }
}
