import Foundation

/// Facts about Vision's SQLite database file that the app can read without the backend or
/// the bundled Bun (ADR-263), ported from `packaging/electron/runtime/database-stats.ts`:
/// the sizes of the database, its write-ahead log and shared-memory index, and the fields of
/// the 100-byte SQLite file header (page size, page count, freelist, the schema version the
/// migration runner records in `user_version`, and the SQLite library that last wrote it).
///
/// In WAL mode the header describes the database as of the last checkpoint; pages committed
/// since then live in the `-wal` file, whose size is reported separately. Integrity and the
/// migration ledger are checked by `tools/db-file.js verify`, not here.
public enum DatabaseStatistics {
    /// `SQLITE_HEADER_MAGIC`: the 16 bytes every SQLite 3 database file starts with.
    public static let headerMagic = Data("SQLite format 3\0".utf8)
    /// `SQLITE_HEADER_BYTES`.
    public static let headerBytes = 100

    /// `IMPORTANT_TABLES`: user-data tables whose row counts a restore or Demo seed keeps.
    public static let importantTables = [
        "accounts", "attachments", "investments", "planned_transactions", "portfolio_transactions", "recipients",
        "transactions", "user_settings",
    ]
    /// `STARTUP_WRITTEN_TABLES`: important tables the backend writes on its own once it
    /// runs (daily-job and repair bookkeeping), so a comparison after startup skips them.
    public static let startupWrittenTables = ["user_settings"]
    /// `STABLE_TABLES`: important tables a comparison after the backend started can still
    /// require to be equal.
    public static var stableTables: [String] { importantTables.filter { !startupWrittenTables.contains($0) } }

    private static let textEncodings: [UInt32: SqliteTextEncoding] = [1: .utf8, 2: .utf16le, 3: .utf16be]

    /// `isSqliteHeader`.
    public static func isSqliteHeader(_ data: Data) -> Bool {
        data.count >= headerMagic.count && data.prefix(headerMagic.count) == headerMagic
    }

    /// `sqliteVersionString`: "3.43.2" from `SQLITE_VERSION_NUMBER` 3043002; `nil` for 0.
    public static func sqliteVersionString(_ versionNumber: Int) -> String? {
        guard versionNumber > 0 else { return nil }
        return "\(versionNumber / 1_000_000).\(versionNumber / 1_000 % 1_000).\(versionNumber % 1_000)"
    }

    private static func notSqlite(_ message: String) -> NativeRuntimeError {
        NativeRuntimeError("NOT_SQLITE_DATABASE", message)
    }

    private static func uint16(_ bytes: [UInt8], _ offset: Int) -> Int {
        Int(bytes[offset]) << 8 | Int(bytes[offset + 1])
    }

    private static func uint32(_ bytes: [UInt8], _ offset: Int) -> UInt32 {
        UInt32(bytes[offset]) << 24 | UInt32(bytes[offset + 1]) << 16 | UInt32(bytes[offset + 2]) << 8
            | UInt32(bytes[offset + 3])
    }

    /// `parseSqliteHeader`: the first 100 bytes of a SQLite database file.
    public static func parseHeader(_ data: Data) throws -> SqliteFileHeader {
        guard data.count >= headerBytes, isSqliteHeader(data) else {
            throw notSqlite("The file is not a SQLite database")
        }
        let bytes = [UInt8](data.prefix(headerBytes))
        let rawPageSize = uint16(bytes, 16)
        let pageSize = rawPageSize == 1 ? 65_536 : rawPageSize
        guard pageSize >= 512, pageSize <= 65_536, pageSize & (pageSize - 1) == 0 else {
            throw notSqlite("The SQLite header has an invalid page size")
        }
        let changeCounter = uint32(bytes, 24)
        let headerPages = uint32(bytes, 28)
        let versionValidFor = uint32(bytes, 92)
        return SqliteFileHeader(
            pageSize: pageSize,
            journalMode: bytes[18] == 2 && bytes[19] == 2 ? .wal : .rollback,
            // The in-header size is valid only when it is set and the file was last written by
            // a library that maintains it (SQLite file format, section 1.3.7).
            pageCount: headerPages > 0 && changeCounter == versionValidFor ? Int(headerPages) : nil,
            freelistPages: Int(uint32(bytes, 36)),
            schemaFormat: Int(uint32(bytes, 44)),
            textEncoding: textEncodings[uint32(bytes, 56)],
            userVersion: Int(Int32(bitPattern: uint32(bytes, 60))),
            sqliteVersionNumber: Int(uint32(bytes, 96)))
    }

    private static func size(_ path: String, _ fileSystem: any RuntimeFileSystem) -> Int {
        guard let info = fileSystem.info(path), info.kind == .file else { return 0 }
        return info.size
    }

    /// `isSqliteDatabaseFile`: a regular file (not a symlink) that starts with the magic.
    public static func isDatabaseFile(_ path: String, fileSystem: any RuntimeFileSystem) -> Bool {
        guard fileSystem.info(path)?.kind == .file,
            let head = try? fileSystem.readHead(path, length: headerMagic.count)
        else { return false }
        return isSqliteHeader(head)
    }

    /// `readDatabaseFileStats`: a missing file reports `exists: false`; a path that is not a
    /// regular file throws `DATABASE_PATH_UNSAFE`.
    public static func readFileStats(_ path: String, fileSystem: any RuntimeFileSystem) throws -> DatabaseFileStats {
        let walBytes = size("\(path)-wal", fileSystem)
        let shmBytes = size("\(path)-shm", fileSystem)
        guard let info = fileSystem.info(path) else {
            return DatabaseFileStats(
                file: path, exists: false, bytes: 0, walBytes: walBytes, shmBytes: shmBytes, pageSize: nil,
                pageCount: nil, freelistPages: nil, freeBytes: nil, journalMode: nil, textEncoding: nil,
                schemaVersion: nil, sqliteVersion: nil)
        }
        guard info.kind == .file else {
            throw NativeRuntimeError("DATABASE_PATH_UNSAFE", "The database path is not a regular file")
        }
        if info.size == 0 {
            // SQLite creates the file empty and writes page 1 with the first table.
            return DatabaseFileStats(
                file: path, exists: true, bytes: 0, walBytes: walBytes, shmBytes: shmBytes, pageSize: nil,
                pageCount: 0, freelistPages: 0, freeBytes: 0, journalMode: nil, textEncoding: nil, schemaVersion: 0,
                sqliteVersion: nil)
        }
        let header = try parseHeader(try fileSystem.readHead(path, length: headerBytes))
        return DatabaseFileStats(
            file: path, exists: true, bytes: info.size, walBytes: walBytes, shmBytes: shmBytes,
            pageSize: header.pageSize, pageCount: header.pageCount ?? info.size / header.pageSize,
            freelistPages: header.freelistPages, freeBytes: header.freelistPages * header.pageSize,
            journalMode: header.journalMode, textEncoding: header.textEncoding, schemaVersion: header.userVersion,
            sqliteVersion: sqliteVersionString(header.sqliteVersionNumber))
    }

    /// `describeDatabaseFileStats`: one log line for diagnostics, without paths or data.
    public static func describe(_ stats: DatabaseFileStats) -> String {
        guard stats.exists else { return "database file absent" }
        func text(_ value: Int?) -> String { value.map(String.init) ?? "?" }
        return [
            "bytes=\(stats.bytes)",
            "wal=\(stats.walBytes)",
            "pages=\(text(stats.pageCount))x\(text(stats.pageSize))",
            "free=\(text(stats.freelistPages))",
            "schema=\(text(stats.schemaVersion))",
            "journal=\(stats.journalMode?.rawValue ?? "?")",
            "sqlite=\(stats.sqliteVersion ?? "?")",
        ].joined(separator: " ")
    }

    /// `assertTableCountsEqual`: throws `DATABASE_COUNT_MISMATCH` naming every table whose
    /// row count differs. Without `tables`, every table either side reports is compared.
    public static func assertTableCountsEqual(
        expected: [String: Int], actual: [String: Int], tables: [String]? = nil
    ) throws {
        let names = tables ?? Array(Set(expected.keys).union(actual.keys))
        let mismatches = names.sorted().filter { expected[$0] != actual[$0] }.map { table in
            "\(table): expected \(expected[table].map(String.init) ?? "none"), found \(actual[table].map(String.init) ?? "none")"
        }
        guard mismatches.isEmpty else {
            throw NativeRuntimeError(
                "DATABASE_COUNT_MISMATCH",
                "Database row counts do not match (\(mismatches.joined(separator: "; ")))")
        }
    }
}

public enum SqliteJournalMode: String, Sendable, Equatable {
    case wal
    case rollback
}

public enum SqliteTextEncoding: String, Sendable, Equatable {
    case utf8 = "UTF-8"
    case utf16le = "UTF-16le"
    case utf16be = "UTF-16be"
}

/// `SqliteFileHeader`.
public struct SqliteFileHeader: Sendable, Equatable {
    public let pageSize: Int
    /// `wal` when the file was last opened in WAL mode (format versions 2/2).
    public let journalMode: SqliteJournalMode
    /// Pages according to the header, or `nil` when the header count is stale.
    public let pageCount: Int?
    public let freelistPages: Int
    public let schemaFormat: Int
    public let textEncoding: SqliteTextEncoding?
    /// `PRAGMA user_version`: the migration runner sets it to the latest applied version.
    public let userVersion: Int
    /// `SQLITE_VERSION_NUMBER` of the library that last wrote the file.
    public let sqliteVersionNumber: Int
}

/// `DatabaseFileStats`.
public struct DatabaseFileStats: Sendable, Equatable {
    public let file: String
    public let exists: Bool
    /// Size of the main database file.
    public let bytes: Int
    /// Size of `<file>-wal`; 0 when there is none.
    public let walBytes: Int
    /// Size of `<file>-shm`; 0 when there is none.
    public let shmBytes: Int
    public let pageSize: Int?
    /// Header page count when it is current, otherwise bytes / pageSize.
    public let pageCount: Int?
    public let freelistPages: Int?
    /// Bytes held by free pages that `VACUUM` would return.
    public let freeBytes: Int?
    public let journalMode: SqliteJournalMode?
    public let textEncoding: SqliteTextEncoding?
    /// Latest applied migration version (header `user_version`); `nil` without a file.
    public let schemaVersion: Int?
    /// "3.43.2" for the library that last wrote the file.
    public let sqliteVersion: String?
}
