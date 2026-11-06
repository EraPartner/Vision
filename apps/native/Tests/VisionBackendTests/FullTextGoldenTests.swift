import Foundation
import Testing

@testable import VisionBackend

/// fts.golden.json: PostgreSQL 18.6 (C locale) ts_debug tokens, to_tsvector('simple'),
/// websearch_to_tsquery('simple'), `@@` and ts_rank_cd.
@Suite struct FullTextGoldenTests {
    static func vectors(_ op: String) throws -> [[String: Any]] {
        try GoldenFixtures.vectors("fts.golden.json").filter { $0["op"] as? String == op }
    }

    /// A long passage stored compactly: prefix + repeat * times + suffix.
    static func expand(_ passage: Any) -> String {
        if let text = passage as? String { return text }
        guard let spec = passage as? [String: Any] else { return "" }
        let repeated = String(repeating: spec["repeat"] as? String ?? "", count: spec["times"] as? Int ?? 0)
        return (spec["prefix"] as? String ?? "") + repeated + (spec["suffix"] as? String ?? "")
    }

    @Test func parserAndTsvectorMatch() throws {
        var mismatches: [String] = []
        for vector in try Self.vectors("passage") {
            let text = vector["text"] as? String ?? ""
            let want = (vector["tokens"] as? [[String]] ?? []).map { $0.joined(separator: "|") }
            let got = SQLFullText.parseTokens(text).map { "\(SQLFullText.tokenTypes[$0.type])|\($0.text)" }
            if got != want { mismatches.append("\(text)\n  pg  \(want)\n  got \(got)") }
            let tsvector = SQLFullText.formatTsvector(SQLFullText.toTsvector(text))
            if tsvector != vector["tsvector"] as? String {
                mismatches.append("\(text)\n  pg  \(vector["tsvector"] ?? "")\n  got \(tsvector)")
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.prefix(20).joined(separator: "\n"))")
    }

    @Test func websearchQueriesMatch() throws {
        var mismatches: [String] = []
        for vector in try Self.vectors("query") {
            let text = vector["text"] as? String ?? ""
            let got = SQLFullText.formatTsquery(try SQLFullText.websearchToTsquery(text))
            if got != vector["tsquery"] as? String { mismatches.append("\(text): pg \(vector["tsquery"] ?? "nil"), got \(got)") }
        }
        #expect(mismatches.isEmpty, "\(mismatches.joined(separator: "\n"))")
    }

    @Test func matchAndRankMatchEveryPair() throws {
        let db = try GoldenFixtures.connection()
        let matrices = try Self.vectors("matrix")
        #expect(
            matrices.map { ($0["passages"] as? [Any] ?? []).count * ($0["queries"] as? [String] ?? []).count }
                == [3763, 645])
        var mismatches: [String] = []
        for matrix in matrices {
            let queries = matrix["queries"] as? [String] ?? []
            let matches = matrix["matches"] as? [String] ?? []
            let ranks = matrix["ranks"] as? [[String]] ?? []
            for (p, raw) in (matrix["passages"] as? [Any] ?? []).enumerated() {
                let passage = Self.expand(raw)
                let row = Array(p < matches.count ? matches[p] : "")
                for (q, query) in queries.enumerated() {
                    let expectedMatch: Int64 = q < row.count && row[q] == "t" ? 1 : 0
                    let match = try db.scalar("SELECT vision_fts_match(?, ?)", [.text(passage), .text(query)])
                    if match != .integer(expectedMatch) {
                        mismatches.append("\(passage.prefix(80)) @@ \(query): pg \(expectedMatch), got \(String(describing: match))")
                    }
                    let expectedRank = Double(p < ranks.count && q < ranks[p].count ? ranks[p][q] : "") ?? .nan
                    let rank = try db.scalar("SELECT vision_fts_rank(?, ?)", [.text(passage), .text(query)])
                    if rank != .real(expectedRank) {
                        mismatches.append("\(passage.prefix(80)) / \(query): pg \(expectedRank), got \(String(describing: rank))")
                    }
                }
            }
        }
        #expect(mismatches.isEmpty, "\(mismatches.count) mismatches:\n\(mismatches.prefix(40).joined(separator: "\n"))")
    }

    @Test func nullsAndTypes() throws {
        let db = try GoldenFixtures.connection()
        #expect(try db.scalar("SELECT vision_fts_match(NULL, 'rent')") == .null)
        #expect(try db.scalar("SELECT vision_fts_rank('rent', NULL)") == .null)
        #expect(try db.scalar("SELECT typeof(vision_fts_match('rent', 'rent'))") == .text("integer"))
        #expect(try db.scalar("SELECT typeof(vision_fts_rank('rent', 'rent'))") == .text("real"))
        #expect(try db.scalar("SELECT vision_fts_match('rent', '')") == .integer(0))
    }
}
