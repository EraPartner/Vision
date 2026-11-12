import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// The Swift side of `scheduleRefresh` (`services/materializedViewService.ts`): a category
/// write refills the dashboard aggregate tables with the TypeScript fill SQL.
@Suite struct MaterializedViewTests {
    static let service = PersistenceTests.migrations.deletingLastPathComponent().deletingLastPathComponent()
        .appendingPathComponent("apps/node-backend/src/services/materializedViewService.ts")

    /// The TypeScript template literal `const <name> = \`...\`;`, whitespace runs collapsed.
    static func typeScriptFill(_ name: String, in source: String) -> String? {
        guard let start = source.range(of: "const \(name) = `"),
            let end = source.range(of: "`;", range: start.upperBound..<source.endIndex)
        else { return nil }
        return collapsed(String(source[start.upperBound..<end.lowerBound]))
    }

    static func collapsed(_ text: String) -> String {
        text.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    @Test func fillSQLMatchesTheTypeScriptService() throws {
        let source = try String(contentsOf: Self.service, encoding: .utf8)
        let fills = Dictionary(uniqueKeysWithValues: MaterializedViewRefresher.fills.map { ($0.table, $0.sql) })
        #expect(fills.count == 2)
        #expect(Self.typeScriptFill("MONTHLY_SUMMARY_FILL", in: source) == fills["mv_monthly_summary"].map(Self.collapsed))
        #expect(Self.typeScriptFill("CATEGORY_TOTALS_FILL", in: source) == fills["mv_category_totals"].map(Self.collapsed))
    }

    @Test func aCategoryWriteRefillsTheTables() async throws {
        let corpus = try JSONDecoder().decode(
            ParityTests.Corpus.self,
            from: Data(contentsOf: ParityTests.corpusDirectory.appendingPathComponent("categories.json")))
        let file = try ParityTests.migratedDatabase(seed: corpus.seed)
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let database = BackendDatabase(path: file.path, time: ParityTests.recorderTime)
        let views = MaterializedViewRefresher(
            database: database, timing: .init(debounce: .milliseconds(20), maxWait: .milliseconds(200)))
        let backend = InProcessBackend.live(
            database: database, fetcher: ParityTests.StubFetcher(stubs: [:]), views: views)
        let transport = RoutingAPITransport(
            backend: backend, fallback: ParityTests.NoFallback(), streamFallback: ParityTests.NoFallback())
        let url = try #require(URL(string: "http://127.0.0.1:3001/api/categories/tree/4"))
        let response = try await transport.send(
            APIRequest(
                method: .patch, url: url, headers: ["Content-Type": "application/json"],
                body: Data(#"{"name":"dining"}"#.utf8), timeout: 30))
        #expect(response.status == 200)

        var totals: [[String]] = []
        for _ in 0..<200 {
            totals = try await database.run { session in
                try session.rows("SELECT category_id, name, count FROM mv_category_totals ORDER BY category_id").map {
                    [String(try $0.int64("category_id")), try $0.text("name"), String(try $0.int64("count"))]
                }
            }
            if !totals.isEmpty { break }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        #expect(totals == [["4", "FOOD:DINING", "1"]])
    }
}
