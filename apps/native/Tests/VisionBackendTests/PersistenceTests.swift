import CryptoKit
import Foundation
import Testing

@testable import VisionBackend

/// The ledger check, typed rows and the opener (ADR-270 6b).
@Suite struct PersistenceTests {
    static let migrations = GoldenFixtures.directory
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("db/migrations")

    @Test func expectedLedgerMatchesTheMigrationFiles() throws {
        let files = try FileManager.default.contentsOfDirectory(atPath: Self.migrations.path)
            .filter { $0.hasSuffix(".sql") && !$0.hasSuffix(".down.sql") }.sorted()
        let entries = try files.enumerated().map { offset, file in
            let data = try Data(contentsOf: Self.migrations.appendingPathComponent(file))
            let hash = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
            return MigrationLedger.Entry(version: Int64(offset + 1), name: String(file.dropLast(4)), sha256: hash)
        }
        #expect(entries == MigrationLedger.expected)
    }

    static func ledgerDb(_ entries: [MigrationLedger.Entry]) throws -> SQLiteConnection {
        let db = try GoldenFixtures.connection()
        try db.execute(
            "CREATE TABLE vision_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL)"
        )
        for entry in entries {
            try db.query(
                "INSERT INTO vision_migrations VALUES (?, ?, ?, '2026-11-06T00:00:00.000000Z')",
                [.integer(entry.version), .text(entry.name), .text(entry.sha256)])
        }
        return db
    }

    @Test func ledgerCheckRefusesEveryOtherHead() throws {
        let expected = MigrationLedger.expected
        try MigrationLedger.check(try Self.ledgerDb(expected))
        #expect(throws: MigrationLedger.Mismatch.noLedger) { try MigrationLedger.check(try GoldenFixtures.connection()) }
        #expect(throws: MigrationLedger.Mismatch.behind(applied: expected[0].name, expected: expected[2].name)) {
            try MigrationLedger.check(try Self.ledgerDb(Array(expected.prefix(1))))
        }
        let newer = MigrationLedger.Entry(version: 4, name: "0004_future", sha256: String(repeating: "0", count: 64))
        #expect(throws: MigrationLedger.Mismatch.ahead(unknown: "0004_future")) {
            try MigrationLedger.check(try Self.ledgerDb(expected + [newer]))
        }
        var edited = expected
        edited[1] = MigrationLedger.Entry(version: 2, name: edited[1].name, sha256: String(repeating: "f", count: 64))
        #expect(throws: MigrationLedger.Mismatch.changed(version: 2)) { try MigrationLedger.check(try Self.ledgerDb(edited)) }
    }

    @Test func rowsDecodeByColumnAndCheckStorageTypes() throws {
        let db = try GoldenFixtures.connection()
        let rows = try db.rows(
            "SELECT 7 AS id, 'Rent' AS name, '-12.50' AS amount, '2026-01-31' AS day, 1 AS flag, NULL AS note, 2.5 AS ratio, '{\"a\": 1}' AS meta"
        )
        let row = try #require(rows.first)
        #expect(try row.int64("id") == 7)
        #expect(try row.text("name") == "Rent")
        #expect(try row.decimal("amount") == ExactDecimal.parse("-12.50"))
        #expect(try row.date("day") == SQLTimestamps.CivilDate(year: 2026, month: 1, day: 31))
        #expect(try row.bool("flag"))
        #expect(try row.optionalText("note") == nil)
        #expect(try row.double("ratio") == 2.5)
        #expect(try row.jsonb("meta") == .object([(key: "a", value: .number(ExactDecimal.parse("1")))]))
        #expect(throws: SQLRowDecodingError(column: "note", problem: "is NULL")) { try row.text("note") }
        #expect(throws: SQLRowDecodingError(column: "name", problem: "expected INTEGER, got TEXT")) { try row.int64("name") }
        #expect(throws: SQLRowDecodingError(column: "missing", problem: "no such column")) { try row.value("missing") }
    }
}
