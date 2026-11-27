import Foundation
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Regression tests for the backend findings of Astra bug report 1 (2026-11-27), each against a
/// freshly migrated database.
@Suite struct AstraReportBackendTests {
    static let stamp = "'2025-03-01T09:00:00.000000Z'"

    /// One account, one payee and the given transaction rows.
    static func database(_ transactions: [String]) throws -> BackendDatabase {
        let file = try ParityTests.migratedDatabase(seed: [
            "INSERT INTO recipients (id, name, normalized_name, is_active, created_at, updated_at) VALUES"
                + " (1, 'Seeded', 'seeded', 1, \(stamp), \(stamp))",
            "INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES"
                + " (1, 'Main', 'EUR', 'checking', \(stamp), \(stamp), '00000000-0000-4000-8000-000000000001')",
        ] + transactions)
        return BackendDatabase(path: file.path, attachmentsDirectory: file.deletingLastPathComponent().path + "/attachments")
    }

    static func transaction(id: Int, date: String, amount: String, sequence: Int? = nil) -> String {
        "INSERT INTO transactions (id, date, amount, currency, recipient_id, account_id, is_active, bank_sequence,"
            + " created_at, updated_at) VALUES (\(id), '\(date)', vision_numeric('\(amount)', 18, 4), 'EUR', 1, 1, 1,"
            + " \(sequence.map { "vision_numeric('\($0)', 18, 0)" } ?? "NULL"), \(stamp), \(stamp))"
    }

    static func listRequest(_ query: [String: String]) -> InProcessRequest {
        InProcessRequest(
            operationId: "getTransactions", method: .get, pathParameters: [:],
            queryItems: query.map { URLQueryItem(name: $0.key, value: $0.value) }, headers: [:], body: nil)
    }

    static func items(_ result: HandlerResult) -> [[String: JSONValue]] {
        guard case .object(let body) = result.data, case .array(let items)? = body["items"] else { return [] }
        return items.compactMap { item in
            if case .object(let fields) = item { return fields }
            return nil
        }
    }

    /// Finding 12: Needs category sorted by category answered a 500 (missing joins).
    @Test func needsCategorySortedByCategoryLists() async throws {
        let database = try Self.database([
            Self.transaction(id: 1, date: "2026-01-05", amount: "-12.5"),
            Self.transaction(id: 2, date: "2026-01-06", amount: "-3"),
        ])
        let result = try await database.run { session in
            try TransactionsArea.list(
                session,
                try TransactionsArea.listQuery(
                    Self.listRequest([
                        "uncategorised": "true", "sort_by": "category", "sort_dir": "asc", "include_balance": "true",
                    ])))
        }
        #expect(result.status == 200)
        #expect(Self.items(result).count == 2)
    }

    /// Finding 49: same-day rows list in bank order, so the running balances read in order.
    @Test func sameDayRowsListInBankOrder() async throws {
        let database = try Self.database([
            // Bank order: +100 (sequence 1) then +30 (sequence 2); ids the other way round.
            Self.transaction(id: 1, date: "2026-01-05", amount: "30", sequence: 2),
            Self.transaction(id: 2, date: "2026-01-05", amount: "100", sequence: 1),
        ])
        let result = try await database.run { session in
            try TransactionsArea.list(
                session, try TransactionsArea.listQuery(Self.listRequest(["include_balance": "true"])))
        }
        let ids: [JSONValue] = Self.items(result).map { $0["id"] ?? .null }
        #expect(ids == [.int(1), .int(2)])
    }

    /// Findings 5 and 34: euro thresholds and the (euro) manual adjustments scale into the
    /// dashboard currency, so the estimate is the euro estimate converted, not a new tax.
    @Test func portfolioTaxEstimatesFollowTheEuroThresholds() throws {
        func dashboard(_ currency: String, gain: Double) throws -> JSValue {
            let investment = JSObject([
                ("id", .number(1)), ("name", .string("Fund")), ("assetClass", .string("stock")),
                ("currency", .string("EUR")), ("realizedGain", .number(gain)), ("currentValue", .number(0)),
                ("transactions", .array([])),
            ])
            let adjustments = JSValue.object(
                JSObject([("2026:1", .object(JSObject([("taxes", .number(0)), ("fees", .number(120))])))]))
            return try PortfolioTaxDashboard.build(
                summaries: [investment], year: 2026, currency: currency, totalPIT: 0, filingStatus: "single",
                hasProfile: true, adjustments: adjustments, classifications: nil
            ) { amount, from in
                switch from ?? "EUR" {
                case "EUR": return currency == "JPY" ? amount * 100 : amount
                case "JPY": return amount
                default: return nil
                }
            }
        }
        func figure(_ value: JSValue, _ group: String, _ key: String) -> Double {
            value.objectValue?[group]?.objectValue?[key]?.javaScriptNumber ?? .nan
        }
        // Below the exemption in euros stays untaxed in yen.
        #expect(figure(try dashboard("EUR", gain: 5000), "estimates", "cgtEstimate") == 0)
        #expect(figure(try dashboard("JPY", gain: 5000), "estimates", "cgtEstimate") == 0)
        // Above it, the yen estimate is the euro estimate at 100 yen per euro.
        let euro = figure(try dashboard("EUR", gain: 50000), "estimates", "cgtEstimate")
        let yen = figure(try dashboard("JPY", gain: 50000), "estimates", "cgtEstimate")
        #expect(euro > 0)
        #expect(abs(yen - euro * 100) < 0.0001)
        // The €120 manual fee is ¥12,000.
        #expect(figure(try dashboard("JPY", gain: 0), "totals", "totalManualFees") == 12000)
    }
}
