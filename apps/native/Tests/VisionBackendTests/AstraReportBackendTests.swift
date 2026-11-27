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
                + " (1, 'Seeded', 'SEEDED', 1, \(stamp), \(stamp))",
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

    /// The HTTP status of the error a call throws, or nil when it returns.
    static func status(_ call: () throws -> Void) -> Int? {
        do {
            try call()
            return nil
        } catch let error as BackendHTTPError {
            return error.status
        } catch {
            return 500
        }
    }

    /// Findings 14, 53 and 55: payee creation.
    @Test func payeeCreationIsAtomicAndKeepsExistingNotes() async throws {
        let database = try Self.database([
            "UPDATE recipients SET notes = 'Keep me' WHERE id = 1"
        ])
        try await database.run { session in
            // 55: the reserved name is a 400 with its reason.
            #expect(Self.status { _ = try RecipientsArea.create(session, JSObject([("name", .string("system"))])) } == 400)
            // 14: a stale category refuses the payee and leaves none behind.
            #expect(
                Self.status {
                    _ = try RecipientsArea.create(
                        session, JSObject([("name", .string("Fresh")), ("default_category_id", .number(987_654))]))
                } == 400)
            #expect(try session.row("SELECT id FROM recipients WHERE normalized_name = 'FRESH'") == nil)
            // 53: adding an existing payee does not overwrite its note.
            let result = try RecipientsArea.create(
                session, JSObject([("name", .string("Seeded")), ("notes", .string("Replaced"))]))
            #expect(result.status == 200)
            #expect(try session.row("SELECT notes FROM recipients WHERE id = 1")?.text("notes") == "Keep me")
        }
    }

    /// Finding 13: merging two payees that each have a primary account keeps one primary.
    @Test func mergingPayeesWithPrimaryAccountsSucceeds() async throws {
        let database = try Self.database([
            "INSERT INTO recipients (id, name, normalized_name, is_active, created_at, updated_at) VALUES"
                + " (2, 'Other', 'OTHER', 1, \(Self.stamp), \(Self.stamp))",
            "INSERT INTO recipient_bank_accounts (recipient_id, account_number, is_primary) VALUES (1, 'BE01', 1)",
            "INSERT INTO recipient_bank_accounts (recipient_id, account_number, is_primary) VALUES (2, 'BE02', 1)",
        ])
        try await database.run { session in
            let result = try RecipientsArea.merge(session, RecipientID(rawValue: 1), [RecipientID(rawValue: 2)])
            #expect(result.status == 200)
            let primaries = try session.rows(
                "SELECT account_number FROM recipient_bank_accounts WHERE recipient_id = 1 AND is_primary")
            #expect(try primaries.map { try $0.text("account_number") } == ["BE01"])
        }
    }

    /// Finding 67: submitting an active tag again is not a reactivation.
    @Test func anActiveTagIsNotReactivated() async throws {
        let database = try Self.database([])
        try await database.run { session in
            let first = try TagsArea.create(session, .init(slug: "groceries"))
            let second = try TagsArea.create(session, .init(slug: "groceries"))
            #expect(first.status == 201 && second.status == 200)
            let body = second.data.objectValue
            #expect(body?["reactivated"] == .bool(false) && body?["created"] == .bool(false))
        }
    }

    /// Finding 52: a root cannot take a name another root's legacy redirect holds.
    @Test func aRootCannotTakeAReservedName() async throws {
        let database = try Self.database([])
        try await database.run { session in
            func create(_ name: String) throws -> CategoryID {
                let result = try CategoriesArea.createNode(session, JSObject([("name", .string(name))]))
                guard case .object(let node) = result.data, case .int(let id)? = node["id"] else {
                    throw BackendHTTPError.notFound("no node id")
                }
                return CategoryID(rawValue: id)
            }
            let held = try create("Held")
            let other = try create("Other")
            _ = try session.rows(
                "INSERT INTO category_root_aliases (general, target_category_id) VALUES ('ALPHA', ?)", [held.sqlValue])
            #expect(
                Self.status {
                    _ = try CategoriesArea.updateNode(
                        session, id: other, segment: "\(other.rawValue)", JSObject([("name", .string("Alpha"))]))
                } == 409)
        }
    }

    /// Finding 15: a refresh is a success only when a rate was stored.
    struct FixedFetcher: ProviderFetching {
        let ecb: String
        let erApi: String
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            ProviderResponse(status: 200, body: Data((url.host == "www.ecb.europa.eu" ? ecb : erApi).utf8))
        }
    }

    @Test func aRefreshThatStoresNoRateFails() async throws {
        let database = try Self.database([])
        let failing = FixedFetcher(ecb: "unavailable", erApi: "{not json")
        #expect(await ExchangeRatesArea.refresh(database: database, fetcher: failing) == false)
        let empty = FixedFetcher(ecb: "<Cube></Cube>", erApi: #"{"result":"success","rates":{}}"#)
        #expect(await ExchangeRatesArea.refresh(database: database, fetcher: empty) == false)
        let working = FixedFetcher(ecb: "<Cube currency='USD' rate='1.08'/>", erApi: "{not json")
        #expect(await ExchangeRatesArea.refresh(database: database, fetcher: working))
    }

    /// Finding 22: the Swift backend computes "today" in the zone the Bun backend runs with.
    @Test func theInProcessDatabaseFollowsTheBackendZone() async throws {
        let brussels = try #require(TimeZone(identifier: "Europe/Brussels"))
        let database = BackendDatabase(time: SQLTimestamps(timeZone: brussels))
        await database.resume(databasePath: ":memory:", attachmentsDirectory: nil, timeZone: "Pacific/Kiritimati")
        #expect(await database.timeZoneIdentifier == "Pacific/Kiritimati")
        await database.resume(databasePath: ":memory:", attachmentsDirectory: nil, timeZone: "Not/AZone")
        #expect(await database.timeZoneIdentifier == "Pacific/Kiritimati")
        #expect(
            ChildEnvironment.appTimeZone(runtimeEnvironment: ["APP_TIMEZONE": "Asia/Tokyo"], timeZone: "Europe/Helsinki")
                == "Asia/Tokyo")
        #expect(ChildEnvironment.appTimeZone(runtimeEnvironment: ["APP_TIMEZONE": ""], timeZone: "Europe/Helsinki") == "Europe/Helsinki")
    }

    /// Finding 42: weights that name only an unavailable method do not zero the forecast.
    @Test func weightsForAnUnavailableMethodFallBackToEqualShares() {
        let outputs = [
            ForecastEnsemble.MethodOutput(
                id: "simple_avg", series: [ForecastPoint(date: "2026-01-02", value: 125)], failed: false),
            ForecastEnsemble.MethodOutput(id: "ewma", series: [], failed: true),
        ]
        let points = ForecastEnsemble.forecast(dates: ["2026-01-02"], outputs: outputs, weights: [("ewma", 1)])
        #expect(points == [ForecastPoint(date: "2026-01-02", value: 125)])
    }

    /// Finding 20: an impossible bank date is no date instead of rolling into the next month.
    @Test func anImpossibleBankDateIsRejected() {
        #expect(BankImportText.flexibleDay("2026-02-30") == nil)
        #expect(BankImportText.flexibleDay("2026-13-01") == nil)
        #expect(BankImportText.flexibleDay("2024-02-29") != nil)
    }

    /// Finding 30: two numeric texts compare as numbers; other text keeps text order.
    @Test func numericTextComparesAsNumbers() throws {
        #expect(try FormulaSemantics.compare(.json(.string("10")), .greater, .json(.string("2"))) == true)
        #expect(try FormulaSemantics.compare(.json(.string("2.0")), .equal, .json(.string("2"))) == true)
        #expect(try FormulaSemantics.compare(.json(.string("b")), .greater, .json(.string("a"))) == true)
    }

    /// Finding 48: after selling €600 of €1,000 at cost, a flat €400 portfolio is measured
    /// against its remaining €400 cost, not the €1,000 ever bought.
    @Test func theForecastBaselineIsTheRemainingCostBasis() throws {
        let snapshots = (0..<60).map { _ in PortfolioProjection.Snapshot(value: 400, invested: 400) }
        let input = PortfolioProjection.Input(horizonMonths: 6, paths: 50, seed: "astra-48")
        var summary = PortfolioProjection.Summary(totalPortfolioValue: 400, totalInvested: 1000, holdings: [])
        let gross = try PortfolioProjection.run(input, summary: summary, snapshots: snapshots, today: "2026-01-01")
        summary.totalUnrealizedGain = 0
        let remaining = try PortfolioProjection.run(input, summary: summary, snapshots: snapshots, today: "2026-01-01")
        #expect(gross["probBelowInvested"]?.javaScriptNumber == 1)
        #expect(remaining["probBelowInvested"]?.javaScriptNumber == 0)
    }
}
