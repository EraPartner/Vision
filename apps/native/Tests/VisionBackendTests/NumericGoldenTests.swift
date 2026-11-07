import CryptoKit
import Foundation
import Testing

@testable import VisionBackend

/// The TypeScript backend's golden vectors (apps/node-backend/tests/database/sqlite), whose
/// expected outputs PostgreSQL 18 produced, replayed through the SQL functions a Swift
/// connection registers: the parity corpus of ADR-270 for the SQL functions.
enum GoldenFixtures {
    static let directory = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        .deletingLastPathComponent().appendingPathComponent("node-backend/tests/database/sqlite")

    static func vectors(_ name: String) throws -> [[String: Any]] {
        let data = try Data(contentsOf: directory.appendingPathComponent(name))
        let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        return root?["vectors"] as? [[String: Any]] ?? []
    }

    /// A JSON argument bound as the TypeScript harness binds it.
    static func argument(_ value: Any) -> SQLValue {
        if value is NSNull { return .null }
        if let text = value as? String { return .text(text) }
        if let number = value as? NSNumber {
            if CFNumberIsFloatType(number) { return .real(number.doubleValue) }
            return .integer(number.int64Value)
        }
        return .null
    }

    static func connection() throws -> SQLiteConnection {
        let connection = try SQLiteConnection(path: ":memory:")
        try connection.registerVisionFunctions()
        return connection
    }

    /// `outcome` of harness.ts: a value as text, or the SQLSTATE of the failure.
    enum Outcome: Equatable, CustomStringConvertible {
        case value(String?)
        case error(String)

        var description: String {
            switch self {
            case .value(let text): return "value \(text.map { "\"\($0.prefix(200))\"" } ?? "null")"
            case .error(let code): return "error \(code)"
            }
        }
    }

    static func outcome(_ body: () throws -> SQLValue?) -> Outcome {
        do {
            switch try body() {
            case nil, .null?: return .value(nil)
            case .integer(let number)?: return .value(String(number))
            case .real(let number)?: return .value(SQLArguments.javaScriptText(number))
            case .text(let text)?: return .value(text)
            case .blob?: return .value("<blob>")
            }
        } catch let error as DatabaseError {
            return .error(error.code.isEmpty ? "thrown: \(error.message)" : error.code)
        } catch let error as SQLStateError {
            return .error(error.code)
        } catch {
            return .error("thrown: \(error)")
        }
    }

    static func sha256(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

@Suite struct NumericGoldenTests {
    static let unarySQL: [String: String] = [
        "parse": "SELECT dec(?)",
        "neg": "SELECT dec_neg(?)",
        "abs": "SELECT dec_abs(?)",
        "sign": "SELECT dec_sign(?)",
        "floor": "SELECT dec_floor(?)",
        "ceil": "SELECT dec_ceil(?)",
        "round0": "SELECT dec_round(?)",
        "trunc0": "SELECT dec_trunc(?)",
        "int": "SELECT CAST(dec_int(?) AS TEXT)",
        "real": "SELECT dec_real(?)",
        "add": "SELECT dec_add(?, ?)",
        "sub": "SELECT dec_sub(?, ?)",
        "mul": "SELECT dec_mul(?, ?)",
        "div": "SELECT dec_div(?, ?)",
        "mod": "SELECT dec_mod(?, ?)",
        "round": "SELECT dec_round(?, ?)",
        "trunc": "SELECT dec_trunc(?, ?)",
        "typmod": "SELECT vision_numeric(?, ?, ?)",
        "cmp": "SELECT dec_cmp(?, ?)",
    ]

    static let setSQL: [String: String] = [
        "sum": "SELECT dec_sum(x) FROM t",
        "avg": "SELECT dec_avg(x) FROM t",
        "max": "SELECT dec_max(x) FROM t",
        "min": "SELECT dec_min(x) FROM t",
        "window_sum":
            "SELECT json_group_array(s) FROM (SELECT dec_sum(x) OVER (ORDER BY i ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY i)",
        "window_avg":
            "SELECT json_group_array(s) FROM (SELECT dec_avg(x) OVER (ORDER BY i ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) AS s FROM t ORDER BY i)",
        "order": "SELECT json_group_array(dec(x)) FROM (SELECT x FROM t ORDER BY dec_key(x), i)",
    ]

    @Test func matchesPostgreSQL() throws {
        let vectors = try GoldenFixtures.vectors("numeric.golden.json")
        #expect(vectors.count > 2500)
        let db = try GoldenFixtures.connection()
        try db.execute("CREATE TABLE t (i INTEGER NOT NULL, x TEXT)")
        var mismatches: [String] = []
        for vector in vectors {
            guard let op = vector["op"] as? String, let rawArgs = vector["args"] as? [Any] else { continue }
            let args = rawArgs.map(GoldenFixtures.argument)
            let got = GoldenFixtures.outcome {
                if let sql = Self.unarySQL[op] { return try db.scalar(sql, args) }
                if op == "greatest" || op == "least" {
                    let placeholders = Array(repeating: "?", count: args.count).joined(separator: ", ")
                    return try db.scalar("SELECT dec_\(op)(\(placeholders))", args)
                }
                guard let sql = Self.setSQL[op] else { throw SQLFunctionArgumentError("unknown op \(op)") }
                try db.execute("DELETE FROM t")
                for (index, value) in args.enumerated() {
                    try db.query("INSERT INTO t (i, x) VALUES (?, ?)", [.integer(Int64(index + 1)), value])
                }
                return try db.scalar(sql)
            }
            let want: String
            let actual: String
            if let code = vector["error"] as? String {
                want = "error \(code)"
                actual = got.description
            } else if let list = vector["pgList"] as? [Any] {
                want = "list \(Self.listText(list))"
                if case .value(let text?) = got,
                    let parsed = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [Any]
                {
                    actual = "list \(Self.listText(parsed))"
                } else {
                    actual = got.description
                }
            } else if let digest = vector["pgSha256"] as? String, let length = vector["pgLength"] as? Int {
                want = "length \(length) sha256 \(digest)"
                if case .value(let text?) = got {
                    actual = "length \(text.utf8.count) sha256 \(GoldenFixtures.sha256(text))"
                } else {
                    actual = got.description
                }
            } else {
                let expected = vector["pg"] as? String
                want = GoldenFixtures.Outcome.value(expected).description
                if op == "real", case .value(let text?) = got, let expected, Double(text) == Double(expected) {
                    actual = want
                } else {
                    actual = got.description
                }
            }
            if want != actual {
                let shown = rawArgs.map { String(describing: $0).prefix(60) }.joined(separator: ", ")
                mismatches.append("\(op)(\(shown)): want \(want.prefix(200)), got \(actual.prefix(200))")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) mismatches:\n\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    private static func listText(_ items: [Any]) -> String {
        items.map { $0 is NSNull ? "null" : "\"\($0)\"" }.joined(separator: ",")
    }

    @Test func comparisonFunctionsAgreeWithCmp() throws {
        let db = try GoldenFixtures.connection()
        for vector in try GoldenFixtures.vectors("numeric.golden.json") {
            guard vector["op"] as? String == "cmp", let pg = vector["pg"] as? String, let c = Int(pg),
                let rawArgs = vector["args"] as? [Any], rawArgs.count == 2
            else { continue }
            let args = rawArgs.map(GoldenFixtures.argument)
            for (name, expected) in [
                ("dec_lt", c < 0), ("dec_le", c <= 0), ("dec_gt", c > 0), ("dec_ge", c >= 0), ("dec_eq", c == 0),
                ("dec_ne", c != 0),
            ] {
                #expect(try db.scalar("SELECT \(name)(?, ?)", args) == .integer(expected ? 1 : 0))
            }
        }
    }

    @Test func numericOkAcceptsExactlyTheOutputForm() throws {
        let db = try GoldenFixtures.connection()
        for vector in try GoldenFixtures.vectors("numeric.golden.json") {
            guard vector["op"] as? String == "typmod", let pg = vector["pg"] as? String,
                let rawArgs = vector["args"] as? [Any], rawArgs.count == 3
            else { continue }
            let p = GoldenFixtures.argument(rawArgs[1])
            let s = GoldenFixtures.argument(rawArgs[2])
            #expect(try db.scalar("SELECT vision_numeric_ok(?, ?, ?)", [.text(pg), p, s]) == .integer(1))
            #expect(try db.scalar("SELECT vision_numeric_ok(?, NULL, NULL)", [.text(pg)]) == .integer(1))
            if case .integer(let scale) = s, scale > 0 {
                #expect(try db.scalar("SELECT vision_numeric_ok(?, ?, ?)", [.text(pg + "0"), p, s]) == .integer(0))
            }
        }
        for text in ["-0", "+1", "1e2", ".5", " 1"] {
            #expect(try db.scalar("SELECT vision_numeric_ok(?, NULL, NULL)", [.text(text)]) == .integer(0))
        }
        #expect(try db.scalar("SELECT vision_numeric_ok(NULL, 18, 2)") == .null)
        #expect(try db.scalar("SELECT vision_numeric_ok(12.5, 18, 2)") == .integer(0))
    }

    @Test func refusesFloatingPointInput() throws {
        let db = try GoldenFixtures.connection()
        #expect(GoldenFixtures.outcome { try db.scalar("SELECT dec_add(0.1, '1')") } == .error("42804"))
        #expect(try db.scalar("SELECT dec_add(2, '1.5')") == .text("3.5"))
        #expect(try db.scalar("SELECT dec_add('1', NULL)") == .null)
    }
}

@Suite struct ExactIntegerTests {
    @Test func roundTripsAndDivides() {
        let a = ExactInteger(decimalDigits: "123456789012345678901234567890")!
        let b = ExactInteger(decimalDigits: "987654321987654321")!
        #expect(a.description == "123456789012345678901234567890")
        #expect((a * b).description == "121932631246761163237311385323609205901126352690")
        let (q, r) = a.quotientAndRemainder(dividingBy: b)
        #expect(q.description == "124999998748")
        #expect((q * b + r) == a)
        #expect((-a).quotientAndRemainder(dividingBy: b).remainder == -r)
        #expect(ExactInteger.pow10(20).description == "100000000000000000000")
        #expect(ExactInteger(Int64.min).int64Value == Int64.min)
        #expect(ExactInteger(decimalDigits: "9223372036854775808")!.int64Value == nil)
    }
}
