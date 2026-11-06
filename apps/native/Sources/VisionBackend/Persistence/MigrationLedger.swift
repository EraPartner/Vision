import Foundation

/// The migrations this build was written against (ADR-270 decision 3). The Bun backend applies
/// migrations until the migrator moves; the Swift library only reads `vision_migrations` and
/// refuses a file whose ledger is not exactly this list. A test checks the list against
/// db/migrations, so adding a migration without updating the Swift backend fails CI.
public enum MigrationLedger {
    public struct Entry: Sendable, Equatable {
        public let version: Int64
        /// `NNNN_name`
        public let name: String
        /// SHA-256 of the migration's SQL, as migrate.ts records it.
        public let sha256: String
    }

    public static let expected: [Entry] = [
        Entry(
            version: 1, name: "0001_baseline",
            sha256: "765a5efeba4f6079d7393ea842b1e08fe7863e445408efdbc6b896f74f53b389"),
        Entry(
            version: 2, name: "0002_index_foreign_keys",
            sha256: "a3958ed7cee70cfcfd075ec2e5fba51816ed513065e7640c545e32360e0cf90a"),
        Entry(
            version: 3, name: "0003_exposure_classification_origin",
            sha256: "fcfa1f7bcb209e6ae973c5739552cc1210bfb8de4b0c6dbbfd59f88d609d287f"),
    ]

    public enum Mismatch: Error, Equatable, Sendable, CustomStringConvertible {
        /// The file has no `vision_migrations` table: the Bun backend has not migrated it yet.
        case noLedger
        /// The ledger stops before this build's head: Bun has migrations left to apply.
        case behind(applied: String?, expected: String)
        /// The ledger lists a migration this build does not know: a newer Vision wrote it.
        case ahead(unknown: String)
        /// An applied migration differs from this build's (another name or file hash).
        case changed(version: Int64)

        public var description: String {
            switch self {
            case .noLedger: return "the database has no migration ledger"
            case .behind(let applied, let expected):
                return "the database is at \(applied ?? "no migration"), this build expects \(expected)"
            case .ahead(let unknown): return "the database has migration \(unknown), which this build does not know"
            case .changed(let version): return "migration \(version) differs from the one this build expects"
            }
        }
    }

    /// Throws a `Mismatch` unless the file's ledger is exactly `expected`.
    public static func check(_ connection: SQLiteConnection, expected: [Entry] = expected) throws {
        let ledger = try connection.scalar(
            "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'vision_migrations'")
        guard ledger != nil else { throw Mismatch.noLedger }
        let applied = try connection.rows("SELECT version, name, sha256 FROM vision_migrations ORDER BY version")
            .map { Entry(version: try $0.int64("version"), name: try $0.text("name"), sha256: try $0.text("sha256")) }
        for (index, entry) in applied.enumerated() {
            guard index < expected.count else { throw Mismatch.ahead(unknown: entry.name) }
            if entry != expected[index] { throw Mismatch.changed(version: entry.version) }
        }
        if applied.count < expected.count, let head = expected.last {
            throw Mismatch.behind(applied: applied.last?.name, expected: head.name)
        }
    }
}

/// Opens a Vision database file for the Swift backend: the connection.ts pragmas for the role,
/// every SQL function the schema calls, and the ledger check.
public enum VisionDatabase {
    public static func open(
        path: String, role: SQLiteConnection.Role = .writer, time: SQLTimestamps = SQLTimestamps(),
        clock: SQLConnectionClock = SQLConnectionClock()
    ) throws -> SQLiteConnection {
        let connection = try SQLiteConnection(path: path, role: role)
        try connection.registerVisionFunctions(time: time, clock: clock)
        try connection.registerSchemaFunctions()
        try MigrationLedger.check(connection)
        return connection
    }
}
