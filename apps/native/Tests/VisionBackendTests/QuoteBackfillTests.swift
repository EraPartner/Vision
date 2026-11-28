import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Astra bug report 3, P2: a portfolio transaction create, update or delete refreshes the
/// investment's stored price history (`refreshQuotesForInvestment`), through the routes of the
/// live backend against a freshly migrated database.
@Suite struct QuoteBackfillTests {
    static let stamp = "'2025-03-01T09:00:00.000000Z'"
    static let historyURL = "https://example.com/history"

    /// The custom provider's history: one point per listed UTC day, with a 10× spike on
    /// 2026-01-21 between two 12s.
    struct HistoryFetcher: ProviderFetching {
        static let prices: [(String, Double)] = [
            ("2026-01-05", 10), ("2026-01-12", 11), ("2026-01-20", 12), ("2026-01-21", 120), ("2026-01-22", 12),
        ]

        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            guard url.absoluteString == QuoteBackfillTests.historyURL else { throw URLError(.cannotFindHost) }
            let points = Self.prices.map { day, price in
                "{\"timestamp_ms\":\(Int64(PriceHistory.noon(day))),\"price\":\(price)}"
            }
            return ProviderResponse(status: 200, body: Data("{\"points\":[\(points.joined(separator: ","))]}".utf8))
        }

        /// `example.com` stands for a public address, so the SSRF guard passes without DNS.
        func resolve(_ host: String) throws -> [String] { ["93.184.216.34"] }
    }

    static func send(
        _ transport: RoutingAPITransport, _ method: HTTPMethod, _ path: String, _ body: String? = nil
    ) async throws -> Int {
        let url = try #require(URL(string: "http://127.0.0.1:3001" + path))
        let request = APIRequest(
            method: method, url: url, headers: body == nil ? [:] : ["Content-Type": "application/json"],
            body: body.map { Data($0.utf8) }, timeout: 30)
        return try await transport.send(request).status
    }

    /// The stored closes of investment 1, by day.
    static func stored(_ database: BackendDatabase) async throws -> [String: Double] {
        try await database.run { session in
            var closes: [String: Double] = [:]
            for row in try session.rows(
                "SELECT price_date, close_price FROM asset_price_history WHERE investment_id = 1")
            {
                closes[try row.text("price_date")] = JavaScriptNumber.fromString(try row.text("close_price"))
            }
            return closes
        }
    }

    /// The refresh runs after the answer: poll until `done` holds, at most ten seconds.
    static func eventually(
        _ database: BackendDatabase, _ done: @escaping ([String: Double]) -> Bool
    ) async throws -> [String: Double] {
        var closes: [String: Double] = [:]
        for _ in 0..<400 {
            closes = try await stored(database)
            if done(closes) { return closes }
            try await Task.sleep(nanoseconds: 25_000_000)
        }
        return closes
    }

    @Test func transactionEditsBackfillAndPruneThePriceHistory() async throws {
        let file = try ParityTests.migratedDatabase(seed: [
            "INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, is_active, price_provider,"
                + " price_provider_history_url, created_at, updated_at) VALUES (1, 'Holding 1', 'H1', 'stock', 'EUR',"
                + " vision_numeric('10', 18, 6), 1, 'custom', '\(Self.historyURL)', \(Self.stamp), \(Self.stamp))",
            // A close from before any holding: pruned by the first refresh.
            "INSERT INTO asset_price_history (investment_id, price_date, close_price, source, fetched_at, updated_at)"
                + " VALUES (1, '2025-12-01', vision_numeric('9', 18, 6), 'custom', \(Self.stamp), \(Self.stamp))",
        ])
        defer { try? FileManager.default.removeItem(at: file.deletingLastPathComponent()) }
        let database = BackendDatabase(
            path: file.path, attachmentsDirectory: file.deletingLastPathComponent().path + "/attachments")
        let transport = RoutingAPITransport(
            backend: .live(database: database, fetcher: HistoryFetcher()),
            fallback: ParityTests.NoFallback(), streamFallback: ParityTests.NoFallback())

        // Create: the open window from 2026-01-15 is backfilled, the spike sanitized, the
        // close outside the window deleted.
        let created = try await Self.send(
            transport, .post, "/api/investments/1/transactions",
            #"{"type":"buy","date":"2026-01-15","amount":"1000","units":"10","price_per_unit":"100"}"#)
        #expect(created == 201)
        let afterCreate = try await Self.eventually(database) { $0["2025-12-01"] == nil && $0["2026-01-20"] != nil }
        #expect(afterCreate.keys.sorted() == ["2026-01-20", "2026-01-21", "2026-01-22"])
        #expect(afterCreate["2026-01-21"] == 12)

        // Update: moving the first purchase earlier backfills the new start of the window.
        let found = try await database.run { session in
            try session.row("SELECT id FROM portfolio_transactions WHERE investment_id = 1")?.integerId("id")
        }
        let txn = try #require(found)
        let updated = try await Self.send(
            transport, .patch, "/api/investments/transactions/\(txn)", #"{"date":"2026-01-01"}"#)
        #expect(updated == 200)
        let afterUpdate = try await Self.eventually(database) { $0["2026-01-05"] != nil && $0["2026-01-12"] != nil }
        #expect(afterUpdate.keys.sorted() == ["2026-01-05", "2026-01-12", "2026-01-20", "2026-01-21", "2026-01-22"])

        // Delete: with no holding left, every stored close of the investment goes.
        let deleted = try await Self.send(transport, .delete, "/api/investments/transactions/\(txn)")
        #expect(deleted == 204)
        let afterDelete = try await Self.eventually(database) { $0.isEmpty }
        #expect(afterDelete.isEmpty)
    }
}
