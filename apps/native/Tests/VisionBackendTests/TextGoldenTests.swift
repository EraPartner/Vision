import Foundation
import Testing

@testable import VisionBackend

/// text.golden.json: PostgreSQL 18.6 (C locale) outputs for LIKE/ILIKE (with ESCAPE), POSIX
/// regular expressions, pg_trgm, jsonb `@>`, lower/upper, btrim, GREATEST/LEAST and ORDER BY.
@Suite struct TextGoldenTests {
    static let matrixSQL: [String: String] = [
        "like": "SELECT ? LIKE ?",
        "ilike": "SELECT ilike(?, ?)",
        "regex": "SELECT ? REGEXP ?",
        "regex_i": "SELECT regexp_i(?, ?)",
    ]

    static func ofOp(_ vectors: [[String: Any]], _ op: String) -> [[String: Any]] {
        vectors.filter { $0["op"] as? String == op }
    }

    static func strings(_ value: Any?) -> [String] { value as? [String] ?? [] }

    static func args(_ vector: [String: Any]) -> [SQLValue] {
        (vector["args"] as? [Any] ?? []).map(GoldenFixtures.argument)
    }

    /// `t`, `f` or `E:<code>` as text.test.ts writes a boolean outcome.
    static func flag(_ outcome: GoldenFixtures.Outcome, yes: String = "t", no: String = "f") -> String {
        switch outcome {
        case .error(let code): return "E:\(code)"
        case .value("1"): return yes
        case .value("0"): return no
        case .value(let other): return "?\(other ?? "null")"
        }
    }

    @Test(arguments: ["like", "ilike", "regex", "regex_i"])
    func matrixMatchesPostgreSQL(op: String) throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        let matrix = try #require(Self.ofOp(vectors, op).first)
        let values = Self.strings(matrix["values"])
        let patterns = Self.strings(matrix["patterns"])
        let rows = Self.strings(matrix["rows"])
        let errors = matrix["errors"] as? [Any] ?? []
        let sql = try #require(Self.matrixSQL[op])
        var mismatches: [String] = []
        for (p, pattern) in patterns.enumerated() {
            let row = Array(p < rows.count ? rows[p] : "")
            for (v, value) in values.enumerated() {
                let mark = v < row.count ? String(row[v]) : "?"
                let expected = mark == "E" ? "E:\((p < errors.count ? errors[p] as? String : nil) ?? "?")" : mark
                let actual = Self.flag(GoldenFixtures.outcome { try db.scalar(sql, [.text(value), .text(pattern)]) })
                if actual != expected { mismatches.append("\(value) \(op) \(pattern): pg \(expected), got \(actual)") }
            }
        }
        #expect(values.count * patterns.count > 1000)
        #expect(mismatches.isEmpty, "\(mismatches.count) mismatches:\n\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    @Test func specialCharactersAndNulls() throws {
        let db = try GoldenFixtures.connection()
        #expect(try db.scalar("SELECT 'sp-kept' LIKE 'sp-%'") == .integer(1))
        #expect(try db.scalar("SELECT ilike('SP-Kept', 'sp-%')") == .integer(1))
        #expect(try db.scalar("SELECT 'a#b@c:d,e' LIKE '%#%@%:%,%'") == .integer(1))
        #expect(try db.scalar("SELECT NULL LIKE 'a'") == .null)
        #expect(try db.scalar("SELECT ilike('a', NULL)") == .null)
        #expect(try db.scalar("SELECT NULL REGEXP 'a'") == .null)
    }

    @Test func escapeVectorsMatch() throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        var mismatches: [String] = []
        for vector in Self.ofOp(vectors, "like_escape") + Self.ofOp(vectors, "ilike_escape") {
            let sql = vector["op"] as? String == "like_escape" ? "SELECT ? LIKE ? ESCAPE ?" : "SELECT ilike(?, ?, ?)"
            let actual = Self.flag(GoldenFixtures.outcome { try db.scalar(sql, Self.args(vector)) })
            let expected = (vector["error"] as? String).map { "E:\($0)" } ?? (vector["pg"] as? String ?? "?")
            if actual != expected { mismatches.append("\(vector): pg \(expected), got \(actual)") }
        }
        #expect(mismatches.isEmpty, "\(mismatches.joined(separator: "\n"))")
    }

    @Test func similarityMatchesFloat4() throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        let sim = try #require(Self.ofOp(vectors, "similarity").first)
        let names = Self.strings(sim["names"])
        let triangle = sim["upperTriangle"] as? [[String]] ?? []
        var mismatches: [String] = []
        for (i, a) in names.enumerated() {
            for (k, b) in names[i...].enumerated() {
                let expected = Double(i < triangle.count && k < triangle[i].count ? triangle[i][k] : "") ?? .nan
                for (x, y) in [(a, b), (b, a)] {
                    let actual = try db.scalar("SELECT similarity(?, ?)", [.text(x), .text(y)])
                    if actual != .real(expected) { mismatches.append("\(x) ~ \(y): pg \(expected), got \(String(describing: actual))") }
                }
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    @Test func showTrgmAndMatchOperator() throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        for vector in Self.ofOp(vectors, "show_trgm") {
            let input = Self.strings(vector["args"]).first ?? ""
            #expect(SQLText.showTrgm(input) == Self.strings(vector["pgList"]), "\(input)")
        }
        for vector in Self.ofOp(vectors, "trgm_match") {
            let outcome = GoldenFixtures.outcome { try db.scalar("SELECT similarity(?, ?) >= 0.3", Self.args(vector)) }
            #expect(Self.flag(outcome, yes: "true", no: "false") == vector["pg"] as? String, "\(vector)")
        }
    }

    @Test func jsonContainsMatches() throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        var mismatches: [String] = []
        for vector in Self.ofOp(vectors, "json_contains") {
            let outcome = GoldenFixtures.outcome { try db.scalar("SELECT json_contains(?, ?)", Self.args(vector)) }
            let actual = Self.flag(outcome, yes: "true", no: "false")
            let expected = (vector["error"] as? String).map { "E:\($0)" } ?? (vector["pg"] as? String ?? "?")
            if actual != expected { mismatches.append("\(vector): pg \(expected), got \(actual)") }
        }
        #expect(mismatches.isEmpty, "\(mismatches.joined(separator: "\n"))")
    }

    @Test(arguments: ["lower", "upper", "btrim", "greatest", "least"])
    func cCollationFunctionsMatch(op: String) throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        for vector in Self.ofOp(vectors, op) {
            let args = Self.args(vector)
            let params = args.map { _ in "?" }.joined(separator: ", ")
            let got = try db.scalar("SELECT \(op)(\(params))", args)
            #expect(got == (vector["pg"] as? String).map(SQLValue.text), "\(vector)")
        }
    }

    @Test func orderByUsesCCollation() throws {
        let vectors = try GoldenFixtures.vectors("text.golden.json")
        let db = try GoldenFixtures.connection()
        for vector in Self.ofOp(vectors, "order") {
            let json = try String(decoding: JSONSerialization.data(withJSONObject: Self.strings(vector["args"])), as: UTF8.self)
            let rows = try db.query("SELECT value FROM json_each(?) ORDER BY value", [.text(json)])
            #expect(rows.map { $0.first ?? .null } == Self.strings(vector["pgList"]).map(SQLValue.text), "\(vector)")
        }
    }

    @Test func greatestLeastAndMathKeepIntegers() throws {
        let db = try GoldenFixtures.connection()
        #expect(try db.scalar("SELECT greatest(NULL, 2, NULL, 1)") == .integer(2))
        #expect(try db.scalar("SELECT least(NULL, NULL)") == .null)
        #expect(try db.scalar("SELECT typeof(greatest(1, 2))") == .text("integer"))
        #expect(
            try db.scalar("SELECT CAST(greatest(9007199254740993, 9007199254740992.0) AS TEXT)")
                == .text("9007199254740993"))
        #expect(try db.scalar("SELECT least(2, 1.5)") == .real(1.5))
        #expect(try db.scalar("SELECT greatest(3, 2.5)") == .integer(3))
        #expect(try db.scalar("SELECT typeof(floor(5))") == .text("integer"))
        #expect(try db.scalar("SELECT typeof(ceil(-5))") == .text("integer"))
        #expect(try db.scalar("SELECT sign(-7)") == .integer(-1))
        #expect(try db.scalar("SELECT floor(-1.5)") == .real(-2))
        #expect(try db.scalar("SELECT typeof(floor(-1.5))") == .text("real"))
    }
}
