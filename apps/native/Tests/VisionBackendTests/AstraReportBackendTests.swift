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

    /// Finding 17: a 10% year on a calendar-day history annualizes to 10%, not about 6.8%.
    @Test func calendarDayHistoriesAnnualizeOverTheYear() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let start = try #require(calendar.date(from: DateComponents(year: 2025, month: 1, day: 1)))
        let snapshots = try (0...365).map { day -> PortfolioProjection.Snapshot in
            let parts = calendar.dateComponents(
                [.year, .month, .day], from: try #require(calendar.date(byAdding: .day, value: day, to: start)))
            let text = String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
            // A little noise keeps the volatility finite; the year still ends 10% up.
            let wobble: Double = day == 0 || day == 365 ? 1 : (day.isMultiple(of: 2) ? 1.001 : 0.999)
            return .init(value: 1000 * pow(1.1, Double(day) / 365) * wobble, invested: 1000, date: text)
        }
        let undated = snapshots.map { PortfolioProjection.Snapshot(value: $0.value, invested: $0.invested) }
        #expect(abs(PortfolioProjection.observationScale(snapshots) - 365.25 / 252) < 0.0001)
        #expect(PortfolioProjection.observationScale(undated) == 1)
        let summary = PortfolioProjection.Summary(
            totalPortfolioValue: snapshots.last!.value, totalInvested: 1000, holdings: [])
        let result = try PortfolioProjection.run(
            .init(horizonMonths: 12, paths: 100, seed: "astra"), summary: summary, snapshots: snapshots,
            today: "2026-01-01")
        let annual = result["historicalAnnualReturn"]?.javaScriptNumber ?? .nan
        #expect(abs(annual - 0.1) < 0.002)
    }

    /// One IBKR Transaction History statement with the given data rows, in euros.
    static func ibkr(_ rows: [String]) throws -> ParsedPortfolioRows {
        let header =
            "Transaction History,Header,Date,Account,Description,Transaction Type,Symbol,Quantity,Price,"
            + "Price Currency,Gross Amount,Commission,Net Amount,Exchange Rate,Transaction Fees,Sub Type,Multiplier"
        let text = (["Summary,Data,Base Currency,EUR", header] + rows.map { "Transaction History,Data," + $0 })
            .joined(separator: "\n") + "\n"
        var config = PortfolioParserConfig()
        config.format = .ibkrTransactionHistory
        return try PortfolioAdapters.parse(Array(text.utf8), config)
    }

    /// Finding 26: two contracts at 3 with a multiplier of 100 are a 600 principal.
    @Test func ibkrContractsKeepTheirMultiplier() throws {
        let rows = try Self.ibkr(["2026-01-02,U1,Option buy,Buy,OPT,2,3,EUR,-600,-1,-601,1,-,-,100"]).rows
        #expect(rows.count == 1)
        #expect(rows.first?.units == 200 && rows.first?.pricePerUnit == 3)
    }

    /// Finding 27: a euro commission on a yen trade without a rate is held, not relabelled yen.
    @Test func ibkrCommissionWithoutARateIsHeld() throws {
        let rows = try Self.ibkr(["2026-01-02,U1,Yen buy,Buy,JPX,1,1000,JPY,-,-2,-,-,-,-,1"]).rows
        #expect(rows.count == 1)
        #expect(rows.first?.typeRaw.hasPrefix("Unsupported IBKR event") == true)
        #expect(rows.first?.fees == nil)
    }

    /// Finding 37: a pair quoted in another crypto asset has no currency, so it gets no quote.
    @Test func binancePairsAreLabelledByTheirQuote() {
        let payload = JSValue.array([
            .object(JSObject([("symbol", .string("ETHBTC")), ("price", .string("0.05"))])),
            .object(JSObject([("symbol", .string("ETHEUR")), ("price", .string("3000"))])),
            .object(JSObject([("symbol", .string("ETHUSDC")), ("price", .string("3300"))])),
            .object(JSObject([("symbol", .string("ETHGBP")), ("price", .string("2600"))])),
        ])
        let quotes = PriceProviders.binanceQuotes(payload, ids: ["ETHBTC", "ETHEUR", "ETHUSDC", "ETHGBP"])
        #expect(quotes.map(\.symbol) == ["ETHEUR", "ETHUSDC", "ETHGBP"])
        #expect(quotes.map(\.quote.currency) == ["EUR", "USD", "GBP"])
    }

    /// Finding 62: a row without a date is dropped, not dated 1 January 1970.
    @Test func customHistoryRowsNeedADate() {
        let data = JSValue.array([
            .object(JSObject([("timestamp_ms", .null), ("price", .number(125))])),
            .object(JSObject([("timestamp_ms", .string(" ")), ("price", .number(126))])),
            .object(JSObject([("timestamp_ms", .number(1_767_225_600_000)), ("price", .number(130))])),
        ])
        let points = PriceProviders.customPoints(
            data, .init(historyURL: "https://example.com", historyPath: "", timestampPath: "timestamp_ms", pricePath: "price"))
        #expect(points.map(\.price) == [130])
    }

    /// Finding 38: `date1904="true"` is the 1904 date system, as `"1"` is.
    @Test func workbookDateSystemReadsBooleanText() throws {
        func epoch(_ flag: String) throws -> Bool {
            try XLSXWorkbook.workbookInfo(
                Array("<workbook><workbookPr date1904=\"\(flag)\"/><sheets/></workbook>".utf16)
            ).epoch1904
        }
        #expect(try epoch("true") && epoch("1"))
        #expect(try !epoch("false") && !epoch("0"))
    }
}
