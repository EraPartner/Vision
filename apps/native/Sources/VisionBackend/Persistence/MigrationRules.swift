import Foundation

/// A refusal of the migration runner, with the message `migrate.ts` gives (`MigrationError`).
public struct MigrationError: Error, Equatable, Sendable, CustomStringConvertible {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }
}

/// The rules of `apps/node-backend/src/database/migrate.ts` that need no database: which files
/// are migrations, what a ledger allows, what a run applies and backs up, how a pre-migration
/// copy is named and which copies are removed, and the schema fingerprint. The Bun backend
/// still applies migrations (ADR-270 decision 3); a Swift runner would run its SQL around these.
public enum MigrationRules {
    public static let ledgerTable = "vision_migrations"
    /// Pre-migration copies kept next to the database.
    public static let backupsKept = 3
    public static let backupFolder = "pre-migration-backups"

    public struct Migration: Equatable, Sendable {
        public let version: Int
        /// `NNNN_name`
        public let name: String
        public let upSQL: String
        public let downSQL: String?
        public let sha256: String
    }

    public struct Applied: Equatable, Sendable {
        public let version: Int
        public let name: String
        public let sha256: String
        public init(version: Int, name: String, sha256: String) {
            self.version = version
            self.name = name
            self.sha256 = sha256
        }
    }

    private static func isDigit(_ unit: UInt8) -> Bool { unit >= 0x30 && unit <= 0x39 }

    /// `/^(\d{4})_([a-z0-9_]+)\.sql$/`: the version of a migration file name.
    private static func version(ofFile file: String) -> Int? {
        let units = Array(file.utf8)
        guard units.count >= 10, units[0..<4].allSatisfy(isDigit), units[4] == 0x5F, file.hasSuffix(".sql"),
            units[5..<(units.count - 4)].allSatisfy({ isDigit($0) || $0 == 0x5F || ($0 >= 0x61 && $0 <= 0x7A) })
        else { return nil }
        return units[0..<4].reduce(0) { $0 * 10 + Int($1) - 0x30 }
    }

    /// `loadMigrations(dir)` over the directory's `.sql` files (name to text): every
    /// `NNNN_name.sql` in order, numbered from 0001 without gaps, each with its optional
    /// `NNNN_name.down.sql`. When two down files have no migration, the TypeScript names the
    /// one the directory lists first; this names the first by name.
    public static func load(directory: String, files: [String: String]?) throws -> [Migration] {
        guard let files else { throw MigrationError("Migrations directory missing: \(directory)") }
        let names = files.keys.filter { $0.hasSuffix(".sql") }
        // `Array.prototype.sort` orders by UTF-16 code unit.
        let ordered = names.sorted { Array($0.utf16).lexicographicallyPrecedes(Array($1.utf16)) }
        var migrations: [Migration] = []
        for file in ordered where !file.hasSuffix(".down.sql") {
            guard let version = version(ofFile: file) else { throw MigrationError("Invalid migration file name: \(file)") }
            let name = String(file.dropLast(4))
            let up = files[file] ?? ""
            migrations.append(
                Migration(
                    version: version, name: name, upSQL: up, downSQL: files["\(name).down.sql"],
                    sha256: SHA256Digest.hex(Array(up.utf8))))
        }
        for file in ordered where file.hasSuffix(".down.sql") {
            let up = String(file.dropLast(9)) + ".sql"
            if files[up] == nil { throw MigrationError("\(file) has no matching \(up)") }
        }
        for (index, migration) in migrations.enumerated() where migration.version != index + 1 {
            throw MigrationError(
                "Migration numbers must run from 0001 without gaps; found \(migration.name) at position \(index + 1)")
        }
        if migrations.isEmpty { throw MigrationError("No migrations in \(directory)") }
        return migrations
    }

    /// The first twelve UTF-16 units of a recorded hash (`sha256.slice(0, 12)`).
    private static func short(_ hash: String) -> String { String(decoding: Array(hash.utf16.prefix(12)), as: UTF16.self) }

    /// `planMigrations(db, migrations)`: the migrations still to apply, or the reason the
    /// database must not be touched. `hasApplicationObjects` is whether the file holds
    /// anything besides SQLite's own objects and the ledger.
    public static func pending(
        ledger: [Applied], hasApplicationObjects: Bool, migrations: [Migration]
    ) throws -> [Migration] {
        if ledger.isEmpty && hasApplicationObjects {
            throw MigrationError(
                "The database holds tables but no migration ledger; refusing to migrate it. "
                    + "Open a database created by Vision, or restore a Vision backup.")
        }
        let latestKnown = migrations.last?.version ?? 0
        for (index, applied) in ledger.enumerated() {
            if applied.version != index + 1 {
                throw MigrationError("The migration ledger has a gap before version \(applied.version)")
            }
            // The last migration of a version wins, as `new Map(entries)` keeps the last.
            guard let migration = migrations.last(where: { $0.version == applied.version }) else {
                throw MigrationError(
                    "The database was migrated to \(applied.name) by a newer Vision "
                        + "(this build knows up to version \(latestKnown)). Install the newer Vision or restore a backup.")
            }
            if migration.name != applied.name || migration.sha256 != applied.sha256 {
                throw MigrationError(
                    "Migration \(applied.name) changed after it was applied (recorded \(short(applied.sha256)), "
                        + "file \(migration.name) \(short(migration.sha256))). Applied migrations must never be edited; add a new one."
                )
            }
        }
        return Array(migrations.dropFirst(ledger.count))
    }

    /// What one run does, decided before any SQL runs.
    public struct Run: Equatable, Sendable {
        /// The migrations to apply, in order. Empty when the database is current.
        public let pending: [Migration]
        /// The latest applied migration after the run.
        public let revision: String?
        /// The versions a pre-migration copy is written for, when one is due.
        public let backup: Backup?

        public struct Backup: Equatable, Sendable {
            public let from: Int
            public let to: Int
        }
    }

    /// The decisions of `migrateConnection`: pending migrations up to the target, and a
    /// pre-migration copy only for a database file that already has a ledger entry.
    public static func run(
        ledger: [Applied], hasApplicationObjects: Bool, migrations: [Migration], targetVersion: Int? = nil,
        skipBackup: Bool = false, databaseFile: String
    ) throws -> Run {
        let target = targetVersion ?? migrations.last?.version ?? 0
        let pending = try pending(ledger: ledger, hasApplicationObjects: hasApplicationObjects, migrations: migrations)
            .filter { $0.version <= target }
        let current = ledger.last
        guard let last = pending.last else { return Run(pending: [], revision: current?.name, backup: nil) }
        let backup = !skipBackup && databaseFile != ":memory:" ? current.map { Run.Backup(from: $0.version, to: last.version) } : nil
        return Run(pending: pending, revision: last.name, backup: backup)
    }

    /// The decisions of `revertLatestMigration`: the migration whose down SQL runs, and the
    /// revision the database is at afterwards.
    public static func revert(
        ledger: [Applied], hasApplicationObjects: Bool, migrations: [Migration]
    ) throws -> (migration: Migration, revision: String?) {
        _ = try pending(ledger: ledger, hasApplicationObjects: hasApplicationObjects, migrations: migrations)
        let current = ledger.last
        guard let current, current.version >= 1, current.version <= migrations.count,
            migrations[current.version - 1].downSQL?.isEmpty == false
        else {
            throw MigrationError("\(current?.name ?? "No migration") has no down migration; restore a backup instead")
        }
        return (migrations[current.version - 1], ledger.dropLast().last?.name)
    }

    /// `foreignKeyViolations(db)` over the rows of `PRAGMA foreign_key_check`: the first twenty.
    public static func violations(_ rows: [(table: String, rowid: Int64?, parent: String)]) -> [String] {
        rows.prefix(20).map { "\($0.table) row \($0.rowid.map(String.init) ?? "null") -> \($0.parent)" }
    }

    // MARK: Pre-migration copies

    /// The last component of a POSIX path (`path.basename`).
    private static func baseName(_ path: [UInt8]) -> [UInt8] {
        var end = path.count
        while end > 0, path[end - 1] == 0x2F { end -= 1 }
        var start = end
        while start > 0, path[start - 1] != 0x2F { start -= 1 }
        return Array(path[start..<end])
    }

    /// `path.extname` of a last component.
    private static func extensionName(_ base: [UInt8]) -> [UInt8] {
        guard let dot = base.lastIndex(of: 0x2E), dot > 0 else { return [] }
        if base[..<dot].allSatisfy({ $0 == 0x2E }) && dot == base.count - 1 && dot == 1 { return [] }
        return Array(base[dot...])
    }

    /// `path.dirname` of a POSIX path.
    private static func directoryName(_ path: [UInt8]) -> [UInt8] {
        guard let first = path.first else { return [0x2E] }
        let rooted = first == 0x2F
        var end = -1
        var matchedSlash = true
        var index = path.count - 1
        while index >= 1 {
            if path[index] == 0x2F {
                if !matchedSlash {
                    end = index
                    break
                }
            } else {
                matchedSlash = false
            }
            index -= 1
        }
        if end == -1 { return rooted ? [0x2F] : [0x2E] }
        if rooted && end == 1 { return [0x2F, 0x2F] }
        return Array(path[..<end])
    }

    /// `path.join(a, b)` for a non-empty `a` and a plain name `b`.
    private static func joined(_ directory: [UInt8], _ name: String) -> String {
        let rooted = directory.first == 0x2F
        var parts: [[UInt8]] = []
        for part in directory.split(separator: 0x2F).map(Array.init) + [Array(name.utf8)] {
            if part == [0x2E] { continue }
            if part == [0x2E, 0x2E] {
                if let last = parts.last, last != [0x2E, 0x2E] {
                    parts.removeLast()
                } else if !rooted {
                    parts.append(part)
                }
                continue
            }
            parts.append(part)
        }
        let text = parts.map { String(decoding: $0, as: UTF8.self) }.joined(separator: "/")
        return rooted ? "/" + text : (text.isEmpty ? "." : text)
    }

    /// Where pre-migration copies go by default: `pre-migration-backups` next to the file.
    public static func backupDirectory(databaseFile: String) -> String {
        joined(directoryName(Array(databaseFile.utf8)), backupFolder)
    }

    /// `timestampForFile(date)`: the ISO 8601 instant without `-`, `:` and the fraction.
    static func fileTimestamp(_ epochMs: Int64) -> String {
        let dayMs: Int64 = 86_400_000
        let days = epochMs >= 0 ? epochMs / dayMs : -((-epochMs + dayMs - 1) / dayMs)
        let inDay = Int(epochMs - days * dayMs) / 1000
        let civil = XLSXWorkbook.civil(fromDays: Int(days))
        func pad(_ value: Int, _ width: Int) -> String {
            let text = String(value)
            return String(repeating: "0", count: max(0, width - text.count)) + text
        }
        let year = (0...9999).contains(civil.year) ? pad(civil.year, 4) : (civil.year < 0 ? "" : "+") + pad(abs(civil.year), 6)
        return "\(year)\(pad(civil.month, 2))\(pad(civil.day, 2))T\(pad(inDay / 3600, 2))\(pad(inDay / 60 % 60, 2))\(pad(inDay % 60, 2))Z"
    }

    /// The file name of the copy `writePreMigrationBackup` writes at `epochMs`.
    public static func backupName(databaseFile: String, from: Int, to: Int, epochMs: Int64) -> String {
        var base = baseName(Array(databaseFile.utf8))
        let ext = extensionName(base)
        if !ext.isEmpty { base.removeLast(ext.count) }
        return "\(String(decoding: base, as: UTF8.self))-v\(from)-to-v\(to)-\(fileTimestamp(epochMs)).sqlite3"
    }

    /// The collation order of printable ASCII (what `localeCompare` uses): punctuation, then
    /// digits, then letters without regard to case. Anything else orders after, by scalar.
    private static let collation: [Unicode.Scalar: Int] = {
        let order = " _-,;:!?.'\"()[]{}@*/\\&#%`^+<=>|~$0123456789abcdefghijklmnopqrstuvwxyz"
        return Dictionary(uniqueKeysWithValues: order.unicodeScalars.enumerated().map { ($0.element, $0.offset) })
    }()

    /// `a.localeCompare(b) < 0` for file names: the letters decide first, then lower case
    /// goes before upper case at the first place two names differ only by case.
    static func collatesBefore(_ a: String, _ b: String) -> Bool {
        func primary(_ scalar: Unicode.Scalar) -> Int {
            collation[scalar.properties.lowercaseMapping.unicodeScalars.first ?? scalar] ?? 1000 + Int(scalar.value)
        }
        let left = Array(a.unicodeScalars)
        let right = Array(b.unicodeScalars)
        let leftKeys = left.map(primary)
        let rightKeys = right.map(primary)
        if leftKeys != rightKeys { return leftKeys.lexicographicallyPrecedes(rightKeys) }
        for (x, y) in zip(left, right) where x != y {
            return x.properties.isLowercase && !y.properties.isLowercase
        }
        return false
    }

    /// The copies `writePreMigrationBackup` removes after writing one: every `.sqlite3` file
    /// past the newest three, newest first and, at one modification time, last name first.
    public static func copiesToRemove(_ copies: [(name: String, modifiedMs: Double)]) -> [String] {
        let ordered = copies.filter { $0.name.hasSuffix(".sqlite3") }.enumerated().sorted { a, b in
            if a.element.modifiedMs != b.element.modifiedMs { return a.element.modifiedMs > b.element.modifiedMs }
            if collatesBefore(b.element.name, a.element.name) { return true }
            if collatesBefore(a.element.name, b.element.name) { return false }
            return a.offset < b.offset
        }
        return ordered.dropFirst(backupsKept).map(\.element.name)
    }

    // MARK: Schema fingerprint

    public struct SchemaObject: Equatable, Sendable {
        public let type: String
        public let name: String
        public let table: String
        public let sql: String?
        public init(type: String, name: String, table: String, sql: String?) {
            self.type = type
            self.name = name
            self.table = table
            self.sql = sql
        }
    }

    /// The SQL of one schema object as the fingerprint reads it: runs of white space are one
    /// space, the ends are trimmed, and a double-quoted plain identifier loses its quotes.
    static func normalizedSQL(_ sql: String) -> String {
        var collapsed: [Unicode.Scalar] = []
        var inSpace = false
        for scalar in sql.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                inSpace = true
                continue
            }
            if inSpace && !collapsed.isEmpty { collapsed.append(" ") }
            inSpace = false
            collapsed.append(scalar)
        }
        func isStart(_ s: Unicode.Scalar) -> Bool { s == "_" || (s >= "a" && s <= "z") || (s >= "A" && s <= "Z") }
        func isPart(_ s: Unicode.Scalar) -> Bool { isStart(s) || (s >= "0" && s <= "9") }
        var out = String.UnicodeScalarView()
        var index = 0
        while index < collapsed.count {
            if collapsed[index] == "\"", index + 1 < collapsed.count, isStart(collapsed[index + 1]) {
                var end = index + 2
                while end < collapsed.count, isPart(collapsed[end]) { end += 1 }
                if end < collapsed.count, collapsed[end] == "\"" {
                    out.append(contentsOf: collapsed[(index + 1)..<end])
                    index = end + 1
                    continue
                }
            }
            out.append(collapsed[index])
            index += 1
        }
        return String(out)
    }

    /// `schemaFingerprint(db)` over the rows of
    /// `SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND
    /// tbl_name <> 'vision_migrations' ORDER BY type, name`.
    public static func schemaFingerprint(_ objects: [SchemaObject]) -> String {
        let text = objects.map { "\($0.type)\t\($0.name)\t\($0.table)\t\(normalizedSQL($0.sql ?? ""))" }.joined(separator: "\n")
        return SHA256Digest.hex(Array(text.utf8))
    }
}

/// PostgreSQL's boolean input (`booleanInput` of `sqlite/values.ts`), for a value bound where
/// a boolean is stored: text, trimmed and in any case, may be a prefix of true, false, yes or
/// no, `on`, `of` or `off`, or exactly 1 or 0. Anything else raises 22P02.
public enum SQLBooleanInput {
    private static let words: [(word: String, shortest: Int, value: Bool)] = [
        ("true", 1, true), ("false", 1, false), ("yes", 1, true), ("no", 1, false), ("on", 2, true), ("off", 2, false),
    ]

    public static func read(_ raw: String) throws -> Bool {
        let text = JavaScriptWhitespace.trim(raw).lowercased()
        if text == "1" { return true }
        if text == "0" { return false }
        let length = text.utf16.count
        for entry in words where length >= entry.shortest && entry.word.hasPrefix(text) { return entry.value }
        throw SQLStateError("invalid input syntax for type boolean: \"\(raw)\"", code: "22P02")
    }

    /// A bound JSON value: a boolean stays, `null` is no value, a number is read as its text.
    static func read(_ value: JSValue?) throws -> Bool? {
        switch value {
        case nil, .null?: return nil
        case .bool(let flag)?: return flag
        case .string(let text)?: return try read(text)
        case .number(let number)?: return try read(JavaScriptNumber.text(number))
        case .array?: return try read("[object Array]")
        case .object?: return try read("[object Object]")
        }
    }
}
