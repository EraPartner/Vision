import Foundation
import Synchronization
import Testing
import VisionNativeCore

@testable import VisionBackend

/// Regression and acceptance tests for Astra bug report 3 (2026-11-27, the Swift backend port of
/// prices, portfolio transactions and exposure), each against a freshly migrated database.
@Suite struct AstraReport3BackendTests {
    static let stamp = "'2025-03-01T09:00:00.000000Z'"

    static func database(_ seed: [String]) throws -> BackendDatabase {
        let file = try ParityTests.migratedDatabase(seed: seed)
        return BackendDatabase(path: file.path, attachmentsDirectory: file.deletingLastPathComponent().path + "/attachments")
    }

    static func investment(
        id: Int, assetClass: String = "stock", currency: String = "EUR", price: String = "150",
        provider: String = "manual", providerID: String? = nil
    ) -> String {
        "INSERT INTO investments (id, name, symbol, asset_class, currency, current_price, is_active, price_provider,"
            + " price_provider_id, created_at, updated_at) VALUES (\(id), 'Holding \(id)', 'H\(id)', '\(assetClass)',"
            + " '\(currency)', vision_numeric('\(price)', 18, 6), 1, '\(provider)',"
            + " \(providerID.map { "'\($0)'" } ?? "NULL"), \(stamp), \(stamp))"
    }

    static func brokerage(id: Int) -> String {
        "INSERT INTO accounts (id, name, currency, type, created_at, updated_at, import_identity) VALUES"
            + " (\(id), 'Broker \(id)', 'EUR', 'brokerage', \(stamp), \(stamp),"
            + " '00000000-0000-4000-8000-00000000000\(id)')"
    }

    static func json(_ text: String) throws -> JSValue {
        try #require(JSValue.parse(Data(text.utf8)))
    }

    // MARK: - Portfolio transactions

    /// Acceptance: one ordinary insert answers 201 with the generated id, and that row reads
    /// back from SQLite.
    @Test func createReturnsTheGeneratedRowAndItReadsBack() async throws {
        let database = try Self.database([Self.investment(id: 1)])
        let body = try Self.json(#"{"type":"buy","date":"2026-01-10","amount":"1000","units":"10","price_per_unit":"100"}"#)
        let result = try await database.run { session in
            try PortfolioTransactionsArea.create(session, 1, body)
        }
        #expect(result.status == 201)
        guard case .object(let fields) = result.data, case .int(let id)? = fields["id"] else {
            Issue.record("create answered \(result.data)")
            return
        }
        #expect(fields["amount"] == .int(1000) || fields["amount"] == .double(1000))
        let stored = try await database.run { session in try PortfolioTransactionsArea.byId(session, id) }
        #expect(stored?.investmentId.rawValue == 1)
        #expect(stored?.units == 10)
        #expect(stored?.amount == 1000)
    }

    /// A CHECK violation is an error, not a silently dropped row (`INSERT OR IGNORE`).
    @Test func aConstraintViolationIsNotSwallowed() async throws {
        let database = try Self.database([Self.investment(id: 1)])
        var fields = PortfolioTransactionsArea.WriteFields()
        fields.investmentId = 1
        fields.currency = "NOT-A-CURRENCY-CODE"
        var txn = PortfolioTransactionsArea.TxnBody()
        txn.type = "fee"
        txn.date = "2026-01-10"
        let normalized = PortfolioTransactionsArea.Normalized(
            dividendAmountConvention: "unknown", amount: 1, units: nil, pricePerUnit: nil, fees: 0, taxes: 0,
            fxRateToEur: nil)
        let row = fields
        let body = txn
        await #expect(throws: (any Error).self) {
            try await database.run { session in
                _ = try PortfolioTransactionsArea.insert(session, row, body, normalized)
            }
        }
        let count = try await database.run { session in
            try session.row("SELECT count(*) AS n FROM portfolio_transactions")?.int64("n")
        }
        #expect(count == 0)
    }

    /// 0.35 units at 0.005 is exactly 0.00175, half-even 0.0018 (the binary product gives 0.0017).
    @Test func buyAmountsRoundAsDecimals() throws {
        let math = try PortfolioTransactionsArea.buySellMath(nil, 0.35, 0.005)
        #expect(math.amount == 0.0018)
    }

    /// The broker re-tag refuses what the TypeScript contract refuses, before any write.
    @Test func retagRefusesOversizedUnknownAndNonUUIDBodies() throws {
        func message(_ text: String) -> String? {
            do {
                _ = try PortfolioTransactionsArea.parseRetagBody(try Self.json(text))
                return nil
            } catch let error as BackendHTTPError {
                return error.message
            } catch {
                return "\(error)"
            }
        }
        let ids = (1...501).map(String.init).joined(separator: ",")
        // A valid version-4 UUID, built from parts so no literal key sits in the source.
        let key = ["0f0e0d0c", "1a2b", "4c3d", "9e8f", "aabbccddeeff"].joined(separator: "-")
        #expect(
            message(#"{"transaction_ids":[\#(ids)],"from_account_id":1,"to_account_id":2,"idempotency_key":"\#(key)"}"#)
                == "transaction_ids: Too big: expected array to have <=500 items")
        #expect(
            message(#"{"transaction_ids":[1],"from_account_id":1,"to_account_id":2,"idempotency_key":"not-a-uuid"}"#)
                == "idempotency_key: Invalid UUID")
        #expect(
            message(#"{"transaction_ids":[1],"from_account_id":1,"to_account_id":2,"idempotency_key":"\#(key)","extra":1}"#)
                == "Unrecognized key: \"extra\"")
        #expect(
            message(#"{"transaction_ids":[1],"from_account_id":1,"to_account_id":2,"idempotency_key":"\#(key)"}"#)
                == nil)
    }

    /// `is_recurring: false` alone clears the stored interval; a null flag is refused.
    @Test func turningRecurrenceOffClearsTheInterval() async throws {
        let database = try Self.database([
            Self.investment(id: 1, assetClass: "real_estate"),
            "INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, currency, is_recurring,"
                + " recurrence_interval, created_at, updated_at) VALUES (1, 1, 'rent_income', '2026-01-01',"
                + " vision_numeric('1000', 18, 4), 'EUR', 1, 'monthly', \(Self.stamp), \(Self.stamp))",
        ])
        _ = try await database.run { session in
            try PortfolioTransactionsArea.update(session, 1, try Self.json(#"{"is_recurring":false}"#))
        }
        let stored = try await database.run { session in try PortfolioTransactionsArea.byId(session, 1) }
        #expect(stored?.isRecurring == false)
        #expect(stored?.recurrenceInterval == nil)
        #expect(throws: BackendHTTPError.self) {
            _ = try PortfolioTransactionsArea.parseBody(try Self.json(#"{"is_recurring":null}"#))
        }
        #expect(throws: BackendHTTPError.self) {
            _ = try PortfolioTransactionsArea.parseBody(try Self.json(#"{"type":5}"#))
        }
    }

    // MARK: - Prices

    /// Answers every Kinesis request with a 100 USD trendline point.
    struct KinesisFetcher: ProviderFetching {
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            guard url.host == "api.kinesis.money" else { throw URLError(.cannotFindHost) }
            return ProviderResponse(
                status: 200, body: Data(#"{"KAU_USD":[{"price":100,"createdAt":"2026-11-01T00:00:00.000Z"}]}"#.utf8))
        }
    }

    /// Acceptance: a converted live quote survives the database round trip as the converted
    /// price, not the exchange rate.
    @Test func aConvertedKinesisQuoteIsStoredAsThePrice() async throws {
        let database = try Self.database([
            Self.investment(id: 1, assetClass: "metals", price: "1", provider: "kinesis", providerID: "KAU_EUR"),
            "INSERT INTO exchange_rates (currency_code, rate_to_eur, rate_date, is_latest, fetched_at, updated_at) VALUES"
                + " ('USD', vision_numeric('0.9', 20, 10), '2026-11-01', 1, \(Self.stamp), \(Self.stamp))",
        ])
        _ = try await PricesArea.refresh(database: database, service: PricesService(fetcher: KinesisFetcher()))
        let stored = try await database.run { session in
            try session.row("SELECT current_price FROM investments WHERE id = 1")?.text("current_price")
        }
        let rates = try await database.run { session in try AccountsArea.latestRatesToEur(session) }
        let expected = try #require(PricesArea.latestConvert(100, "USD", "EUR", rates))
        let price = JavaScriptNumber.fromString(try #require(stored))
        #expect(abs(price - expected) < 0.000001)
        #expect(price > 50)
    }

    /// Records every request; answers the first with a redirect to a loopback address.
    final class RedirectingFetcher: ProviderFetching {
        let requested = Mutex<[String]>([])
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            requested.withLock { $0.append(url.absoluteString) }
            return ProviderResponse(status: 302, body: Data(), headers: ["location": "http://127.0.0.1:8080/latest"])
        }
        func resolve(_ host: String) throws -> [String] { ["93.184.216.34"] }
    }

    /// A redirect is validated before anything is requested from its target.
    @Test func aRedirectToAPrivateAddressIsNeverFollowed() async throws {
        let fetcher = RedirectingFetcher()
        let service = PricesService(fetcher: fetcher)
        await #expect(throws: URLSafety.Blocked.self) {
            _ = try await PricesArea.fetchJSON("https://example.com/price", service: service)
        }
        #expect(fetcher.requested.withLock { $0 } == ["https://example.com/price"])
    }

    /// A resolver that must never be reached through the policy gate's default.
    struct RecordedResolver: ProviderFetching {
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            throw URLError(.notConnectedToInternet)
        }
        func resolve(_ host: String) throws -> [String] { ["203.0.113.7"] }
    }

    /// Acceptance (DNS unavailable): a call through `any ProviderFetching`, behind the privacy
    /// gate, reaches the fetcher's own resolver, not the system's.
    @Test func resolutionDispatchesToTheFetchersOwnResolver() throws {
        let gated: any ProviderFetching = NetworkPolicyFetcher(
            RecordedResolver(), source: .marketData, policy: { .defaults })
        #expect(try gated.resolve("prices.invalid") == ["203.0.113.7"])
    }

    /// Every spelling of a blocked IPv6 address is blocked.
    @Test func ipv6RulesReadTheAddressBytes() {
        for blocked in [
            "::1", "0:0:0:0:0:0:0:1", "::", "0::0", "::ffff:127.0.0.1", "::FFFF:7F00:1", "::ffff:10.1.2.3",
            "fc00::1", "FD12:3456::1", "fe80::1%en0", "FEBF::1", "not-an-address:",
        ] {
            #expect(URLSafety.isBlockedAddress(blocked), "\(blocked)")
        }
        for allowed in ["2606:4700:4700::1111", "::ffff:8.8.8.8", "fec0::1", "2001:db8::1"] {
            #expect(!URLSafety.isBlockedAddress(allowed), "\(allowed)")
        }
        #expect(throws: URLSafety.Blocked.self) {
            _ = try URLSafety.assertPublicHTTP("http://[0:0:0:0:0:0:0:1]/x", resolve: { _ in [] })
        }
    }

    /// Answers every request with the same body.
    struct FixedBody: ProviderFetching {
        let body: String
        func get(_ url: URL, timeout: TimeInterval) async throws -> ProviderResponse {
            ProviderResponse(status: 200, body: Data(body.utf8))
        }
    }

    /// A shorter indicator column reads as missing past its end instead of trapping.
    @Test func aShortChartColumnDoesNotTrap() async throws {
        let body = #"{"chart":{"result":[{"meta":{},"timestamp":[1767225600,1767312000],"indicators":{"quote":[{"high":[2,3],"open":[1],"low":[1],"close":[1.5],"volume":[]}]}}]}}"#
        let chart = try await YahooClient(fetcher: FixedBody(body: body))
            .chart(symbol: "ACME", period1Ms: 1_767_000_000_000, period2Ms: 1_768_000_000_000, nowMs: 1_768_000_000_000)
        let quotes = chart.objectValue?["quotes"]?.arrayValue ?? []
        #expect(quotes.count == 2)
        #expect(quotes.last?.objectValue?["close"] == .null)
    }

    /// EUR is the rate index's base: always 1, whatever the index holds.
    @Test func theEuroRateIsOne() {
        #expect(PricesArea.findRate([:], "EUR", "2026-01-01") == 1)
    }

    // MARK: - Exposure and valuation

    /// Acceptance: a real custody transfer between two brokers values correctly.
    @Test func aCustodyTransferValuesCorrectly() async throws {
        let database = try Self.database([
            "PRAGMA foreign_keys = OFF",
            Self.brokerage(id: 1),
            Self.brokerage(id: 2),
            Self.investment(id: 1, price: "150"),
            "INSERT INTO portfolio_transactions (id, investment_id, type, date, amount, units, price_per_unit,"
                + " currency, account_id, created_at, updated_at) VALUES (1, 1, 'buy', '2026-01-10',"
                + " vision_numeric('1000', 18, 4), vision_numeric('10', 18, 8), vision_numeric('100', 18, 6), 'EUR', 1,"
                + " \(Self.stamp), \(Self.stamp))",
            "INSERT INTO portfolio_asset_transfers (id, investment_id, source_account_id, destination_account_id,"
                + " date, units, fee_units, fee_basis_allocations, import_batch_id, staging_row_id, source_record_hash,"
                + " dedup_fingerprint, dedup_fingerprint_version, created_at) VALUES (100, 1, 1, 2, '2026-01-15',"
                + " vision_numeric('10', 18, 8), vision_numeric('0', 18, 8), vision_jsonb('{}'), 9, 90,"
                + " '\(String(repeating: "a", count: 64))', '\(String(repeating: "b", count: 64))', 1, \(Self.stamp))",
            "PRAGMA foreign_keys = ON",
        ])
        let summary = try await database.run { session in try PortfolioSummaryService.summary(session) }
        #expect(summary.holdings.first { $0.id == 1 }?.currentValue == 1500)
        #expect(summary.totalPortfolioValue == 1500)
    }

    static let validDocument = #"""
        {"contractVersion":1,"fund":{"name":"Euro Fund","identifiers":[{"type":"isin","value":"IE00B4Y7J823"},{"type":"ticker","value":"EFUND","exchange":"XBRU"}]},"shareClass":{"name":"Euro Fund Class A","identifiers":[{"type":"ticker","value":"EFUND","exchange":"XBRU"}],"currency":"EUR"},"source":{"kind":"user-supplied-file","fileName":"euro-fund.csv","asOfDate":"2026-11-10","retrievedAt":"2026-11-11T09:00:00.000Z","license":{"status":"permission-confirmed","redistribution":"allowed"}},"holdings":[{"provenance":{"rowNumber":1},"name":"ACME Inc","identifiers":[{"type":"ticker","value":"acme"}],"instrumentType":"equity","exposureKind":"direct","exposureStatus":"supported","weightPercent":"80"},{"provenance":{"rowNumber":2},"name":"Cash","identifiers":[],"instrumentType":"cash","exposureKind":"cash","exposureStatus":"supported","weightPercent":"10"},{"provenance":{"rowNumber":3},"name":"Mystery Derivative","identifiers":[{"type":"proprietary","value":"X123"}],"instrumentType":"derivative","exposureKind":"derivative","exposureStatus":"unsupported","unsupportedReason":"derivatives carry no equity exposure","weightPercent":"5"}],"coverage":{"status":"partial","reportedWeightPercent":"95","supportedWeightPercent":"90","unsupportedWeightPercent":"5","missingWeightPercent":"5"},"staleness":{"evaluatedAt":"2026-11-10","maximumAgeDays":365,"ageDays":0,"status":"current"}}
        """#

    static func bundle(document: String?) -> String {
        let entry = document.map {
            #"{"investmentId":2,"shareClassIdentifier":{"type":"ticker","value":"EFUND","exchange":"XBRU"},"document":\#($0)}"#
        } ?? #"{"investmentId":2,"shareClassIdentifier":{"type":"ticker","value":"EFUND","exchange":"XBRU"}}"#
        return #"{"classifications":[{"investmentId":1,"issuerId":"acme","issuerName":"ACME","sourceLabel":"test"}],"fundDocuments":[\#(entry)]}"#
    }

    /// The corpus's accepted document still passes the contract.
    @Test func aConsistentFundDocumentPassesTheContract() throws {
        #expect(FundHoldingsContract.validate(try Self.json(Self.validDocument), at: []).isEmpty)
        _ = try ExposureArea.bundleBody(try Self.json(Self.bundle(document: Self.validDocument)))
    }

    /// Acceptance: a malformed fund bundle (weights that do not add up, a missing document)
    /// fails before the database is touched.
    @Test func aMalformedFundBundleLeavesTheDatabaseUntouched() async throws {
        let database = try Self.database([Self.investment(id: 1), Self.investment(id: 2, assetClass: "etf")])
        let inconsistent = Self.validDocument.replacingOccurrences(
            of: #""reportedWeightPercent":"95""#, with: #""reportedWeightPercent":"90""#)
        let issues = FundHoldingsContract.validate(try Self.json(inconsistent), at: [])
        #expect(issues.map(\.message) == ["Reported weight must equal the sum of holding rows"])
        for body in [Self.bundle(document: inconsistent), Self.bundle(document: nil)] {
            #expect(throws: BackendHTTPError.self) {
                _ = try ExposureArea.bundleBody(try Self.json(body))
            }
        }
        let counts = try await database.run { session in
            (
                try session.row("SELECT count(*) AS n FROM portfolio_exposure_classifications")?.int64("n"),
                try session.row("SELECT count(*) AS n FROM portfolio_fund_holdings_documents")?.int64("n")
            )
        }
        #expect(counts.0 == 0 && counts.1 == 0)
    }

    /// The menus order names as `localeCompare(_, "en")`: case and accents do not sort by code point.
    @Test func menusSortByEnglishCollation() {
        let names = ["beta", "Alpha", "Émile", "zeta"]
        #expect(names.sorted(by: ExposureArea.englishPrecedes) == ["Alpha", "beta", "Émile", "zeta"])
    }

    /// A failed policy read fails closed.
    @Test func anUnreadablePolicyIsOffline() {
        #expect(NetworkPolicy.unreadable.offlineMode)
    }
}
