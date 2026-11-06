import Foundation
import Testing

@testable import VisionBackend

/// timestamps.golden.json: PostgreSQL 18.6 outputs with `TimeZone = 'Europe/Brussels'`,
/// replayed with the same session zone.
@Suite struct TimestampGoldenTests {
    static let brussels = SQLTimestamps(timeZone: TimeZone(identifier: "Europe/Brussels") ?? .gmt)

    static func connection() throws -> SQLiteConnection {
        let connection = try SQLiteConnection(path: ":memory:")
        try connection.registerVisionFunctions(time: brussels)
        return connection
    }

    static let sqlFor: [String: String] = [
        "add_months_date": "SELECT add_months(?, ?)",
        "add_days_date": "SELECT add_days(?, ?)",
        "add_interval_date": "SELECT add_interval(?, ?)",
        "sub_interval_date": "SELECT sub_interval(?, ?)",
        "vision_ts": "SELECT vision_ts(?)",
        "add_interval_ts": "SELECT add_interval(vision_ts(?), ?)",
        "sub_interval_ts": "SELECT sub_interval(vision_ts(?), ?)",
        "add_months_ts": "SELECT add_months(vision_ts(?), ?)",
        "add_days_ts": "SELECT add_days(vision_ts(?), ?)",
        "date_trunc_ts": "SELECT date_trunc(?, vision_ts(?))",
        "date_trunc_date": "SELECT date_trunc(?, ?)",
        "date_part_ts": "SELECT date_part(?, vision_ts(?))",
        "date_part_date": "SELECT date_part(?, ?)",
        "to_char_ts": "SELECT to_char(vision_ts(?), ?)",
        "to_char_date": "SELECT to_char(?, ?)",
        "ts_date": "SELECT ts_date(vision_ts(?))",
        "month_end_ts": "SELECT month_end(vision_ts(?))",
        "date_ts": "SELECT date_ts(?)",
        "month_end": "SELECT month_end(?)",
        "date_diff_days": "SELECT date_diff_days(?, ?)",
        "month_diff": "SELECT month_diff(?, ?)",
        "make_date": "SELECT make_date(?, ?, ?)",
    ]

    /// JavaScript's `Number(text)` for the comparison of date_part results.
    private static func number(_ text: String?) -> String {
        guard let text, let value = Double(text) else { return "NaN" }
        return SQLArguments.javaScriptText(value)
    }

    @Test func matchesPostgreSQL() throws {
        let vectors = try GoldenFixtures.vectors("timestamps.golden.json")
        #expect(vectors.count > 5000)
        let db = try Self.connection()
        var mismatches: [String] = []
        for vector in vectors {
            guard let op = vector["op"] as? String, let rawArgs = vector["args"] as? [Any] else { continue }
            let pg = vector["pg"] as? String
            let want: String
            if let code = vector["error"] as? String {
                want = "error \(code)"
            } else if let pg, pg.hasPrefix("time:") {
                // PostgreSQL turns date + clock time into a timestamp; Vision refuses it.
                want = "error 22023"
            } else if op.hasPrefix("date_part") {
                want = "number \(Self.number(pg))"
            } else if op == "interval_fields" {
                want = "value \(Self.intervalText(pg))"
            } else {
                want = GoldenFixtures.Outcome.value(pg).description
            }
            let got: String
            if op == "interval_fields" {
                do {
                    let interval = try SQLTimestamps.parseInterval(rawArgs.first as? String ?? "")
                    let parts = [interval.months, interval.days, interval.micros].map(SQLArguments.javaScriptText)
                    got = "value [\(parts.joined(separator: ","))]"
                } catch let error as SQLStateError {
                    got = "error \(error.code)"
                }
            } else {
                let outcome = GoldenFixtures.outcome {
                    guard let sql = Self.sqlFor[op] else { throw SQLFunctionArgumentError("unknown op \(op)") }
                    return try db.scalar(sql, rawArgs.map(GoldenFixtures.argument))
                }
                if op.hasPrefix("date_part"), case .value(let text) = outcome {
                    got = "number \(Self.number(text))"
                } else {
                    got = outcome.description
                }
            }
            if got != want {
                let shown = rawArgs.map { String(describing: $0) }.joined(separator: ", ")
                mismatches.append("\(op)(\(shown)): want \(want), got \(got)")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) mismatches:\n\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    /// `JSON.stringify(JSON.parse(pg))` of an `[months, days, micros]` array.
    private static func intervalText(_ pg: String?) -> String {
        guard let pg, let items = try? JSONSerialization.jsonObject(with: Data(pg.utf8)) as? [NSNumber] else {
            return "null"
        }
        return "[" + items.map { SQLArguments.javaScriptText($0.doubleValue) }.joined(separator: ",") + "]"
    }

    @Test func keepsDatesAndTimestampsApart() throws {
        let db = try Self.connection()
        #expect(try db.scalar("SELECT date_trunc('month', '2026-01-31')") == .text("2026-01-01"))
        #expect(
            try db.scalar("SELECT date_trunc('month', '2026-01-31T12:00:00.000000Z')")
                == .text("2025-12-31T23:00:00.000000Z"))
        #expect(try db.scalar("SELECT add_months('2026-01-31', 1)") == .text("2026-02-28"))
        #expect(try db.scalar("SELECT typeof(date_part('year', '2026-01-31'))") == .text("integer"))
        #expect(try db.scalar("SELECT typeof(date_part('epoch', '2026-01-31T12:00:00.500000Z'))") == .text("real"))
        #expect(try db.scalar("SELECT typeof(date_diff_days('2026-03-01', '2026-02-01'))") == .text("integer"))
    }

    @Test func readsDateInputLikePostgreSQL() throws {
        let db = try Self.connection()
        #expect(try db.scalar("SELECT ts_date(vision_ts('2026-01-05T23:30:00Z'))") == .text("2026-01-06"))
        #expect(try db.scalar("SELECT ts_date('2026-01-05T23:30:00.000000Z')") == .text("2026-01-06"))
        #expect(try db.scalar("SELECT ts_date('2026-01-05T23:30:00Z')") == .text("2026-01-05"))
        #expect(try db.scalar("SELECT ts_date('2026-01-05T23:30:00.000Z')") == .text("2026-01-05"))
        #expect(try db.scalar("SELECT ts_date('2026-01-05 01:00:00+14:00')") == .text("2026-01-05"))
        #expect(try db.scalar("SELECT ts_date('2026-01-05')") == .text("2026-01-05"))
        #expect(try db.scalar("SELECT ts_date(NULL)") == .null)
        #expect(GoldenFixtures.outcome { try db.scalar("SELECT ts_date('2026-02-30T10:00:00Z')") } == .error("22008"))
        #expect(GoldenFixtures.outcome { try db.scalar("SELECT ts_date('2026-01-05Tnoon')") } == .error("22007"))
    }

    @Test func acceptsOnlyCanonicalStorageText() throws {
        let db = try Self.connection()
        #expect(try db.scalar("SELECT vision_ts_ok('2026-01-31T12:00:00.000000Z')") == .integer(1))
        #expect(try db.scalar("SELECT vision_ts_ok('2026-01-31T12:00:00Z')") == .integer(0))
        #expect(try db.scalar("SELECT vision_ts_ok('2026-01-31')") == .integer(0))
        #expect(try db.scalar("SELECT vision_date_ok('2026-02-28')") == .integer(1))
        #expect(try db.scalar("SELECT vision_date_ok('2026-02-29')") == .integer(0))
        #expect(try db.scalar("SELECT vision_date_ok('2026-2-28')") == .integer(0))
    }
}
