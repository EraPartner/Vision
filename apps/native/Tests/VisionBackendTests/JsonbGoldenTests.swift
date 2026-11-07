import Foundation
import Testing

@testable import VisionBackend

/// jsonb.golden.json: PostgreSQL 18.6 `x::jsonb::text` and `to_jsonb(x)::text`, replayed
/// through `vision_jsonb` and checked against the `vision_jsonb_ok` CHECK helper.
@Suite struct JsonbGoldenTests {
    static func expected(_ vector: [String: Any]) -> String {
        if let code = vector["error"] as? String { return "E:\(code)" }
        if let pg = vector["pg"] as? String { return pg }
        return "len \(vector["pgLength"] as? Int ?? -1) sha \(vector["pgSha256"] as? String ?? "?")"
    }

    /// `.length` in JavaScript counts UTF-16 units.
    static func actual(_ vector: [String: Any], _ outcome: GoldenFixtures.Outcome) -> String {
        switch outcome {
        case .error(let code): return "E:\(code)"
        case .value(nil): return "?null"
        case .value(let text?):
            if vector["pg"] != nil || vector["error"] != nil { return text }
            return "len \(text.utf16.count) sha \(GoldenFixtures.sha256(text))"
        }
    }

    @Test func castsMatchPostgreSQL() throws {
        let db = try GoldenFixtures.connection()
        let casts = try GoldenFixtures.vectors("jsonb.golden.json").filter { $0["op"] as? String == "cast" }
        #expect(casts.count > 400)
        var mismatches: [String] = []
        for vector in casts {
            let input = (vector["args"] as? [String])?.first ?? ""
            let want = Self.expected(vector)
            let viaSQL = Self.actual(vector, GoldenFixtures.outcome { try db.scalar("SELECT vision_jsonb(?)", [.text(input)]) })
            let direct = Self.actual(vector, GoldenFixtures.outcome { .text(try SQLJsonb.canonicalText(input)) })
            if viaSQL != want || direct != want {
                mismatches.append("\(input.prefix(80)): pg \(want.prefix(80)), sql \(viaSQL.prefix(80)), swift \(direct.prefix(80))")
            }
            if let pg = vector["pg"] as? String {
                if try db.scalar("SELECT vision_jsonb_ok(?)", [.text(pg)]) != .integer(1) {
                    mismatches.append("canonical \(pg.prefix(80)) refused")
                }
                let inputOk = try db.scalar("SELECT vision_jsonb_ok(?)", [.text(input)])
                if inputOk != .integer(input == pg ? 1 : 0) { mismatches.append("input \(input.prefix(80)) gave \(String(describing: inputOk))") }
            } else if vector["error"] != nil, try db.scalar("SELECT vision_jsonb_ok(?)", [.text(input)]) != .integer(0) {
                mismatches.append("invalid \(input.prefix(80)) accepted")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) mismatches:\n\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    @Test func toJsonbOfNumbersMatches() throws {
        let db = try GoldenFixtures.connection()
        for vector in try GoldenFixtures.vectors("jsonb.golden.json") where vector["op"] as? String != "cast" {
            let input = (vector["args"] as? [String])?.first ?? ""
            let argument: SQLValue =
                vector["op"] as? String == "to_jsonb_int8" ? .integer(Int64(input) ?? 0) : .real(Double(input) ?? .nan)
            let outcome = GoldenFixtures.outcome { try db.scalar("SELECT vision_jsonb(?)", [argument]) }
            #expect(Self.actual(vector, outcome) == Self.expected(vector), "\(input)")
        }
    }

    @Test func invalidTextAndNulls() throws {
        let db = try GoldenFixtures.connection()
        for bad in ["", "{a:1}", "[1,]", "01", "NaN"] {
            #expect(GoldenFixtures.outcome { .text(try SQLJsonb.canonicalText(bad)) } == .error("22P02"), "\(bad)")
        }
        #expect(!SQLJsonb.isCanonicalText("not json"))
        #expect(try db.scalar("SELECT vision_jsonb(NULL)") == .null)
        #expect(try db.scalar("SELECT vision_jsonb_ok(NULL)") == .null)
        #expect(try db.scalar("SELECT typeof(vision_jsonb_ok('{}'))") == .text("integer"))
        #expect(try db.scalar("SELECT vision_jsonb_ok(1)") == .integer(0))
        #expect(try SQLJsonb.canonicalText(#"{"amount": 12345678901234567890.10}"#) == #"{"amount": 12345678901234567890.10}"#)
        #expect(try SQLJsonb.canonicalText("[0.10, 1e2, -0]") == "[0.10, 100, 0]")
    }
}
