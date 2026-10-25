import Foundation
import Testing

@testable import VisionNativeCore

@MainActor
@Suite("Native portfolio reads and source scopes")
struct PortfolioReadTests {
    @Test func decimalsDecodeBeforeChartCoordinatesAndMissingFiguresAreContractFailures() async throws {
        let transport = PortfolioReadTransport()
        let client = portfolioReadClient(transport)
        let summary = try await client.portfolioSummary(currency: "EUR", includeArchived: false)
        #expect(summary.summaries.first?.totalUnits == Decimal(string: "0.123456789012345678901"))
        #expect(summary.summaries.first?.cadastralIncome == Decimal(string: "987.654321"))
        #expect(summary.firstInvestmentDate == "2024-02-03")
        await transport.omitRequiredMoney()
        await #expect(throws: APIError.self) {
            try await client.portfolioSummary(currency: "EUR", includeArchived: false)
        }
    }

    @Test func rawMoneyStringsAndIncomeRecognitionRolesAreVerifiedBeforeEditing() throws {
        var row = portfolioTransactionWire(id: 1, investmentId: 7)
        row["amount"] = .string("123.456789012345678901")
        row["income_recognition_role"] = nil
        let decoded = try row.decode(PortfolioTransaction.self)
        #expect(decoded.amount == Decimal(string: "123.456789012345678901"))
        #expect(decoded.incomeRecognitionRole == .standard)
        row["amount"] = .string("123 USD")
        #expect(throws: DecodingError.self) { try row.decode(PortfolioTransaction.self) }
        row["amount"] = .number(1)
        row["income_recognition_role"] = .string("included_in_units")
        #expect(throws: DecodingError.self) { try row.decode(PortfolioTransaction.self) }
        row["type"] = .string("dividend")
        #expect(try row.decode(PortfolioTransaction.self).incomeRecognitionRole == .includedInUnits)
        row["income_recognition_role"] = .null
        #expect(throws: DecodingError.self) { try row.decode(PortfolioTransaction.self) }
    }

    @Test func archivedHoldingsComeFromTheAllHoldingsSummaryAndNeverContaminateActiveTotals() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        #expect(model.summary?.totals.totalPortfolioValue == 100)
        #expect(model.archiveSummary?.totals.totalPortfolioValue == 150)
        #expect(model.active.map(\.id) == [1])
        // The archived row is the canonical summary of the `active=false` read (dated FX, the
        // configured cost-basis method), not a client replay.
        #expect(model.archived.map(\.id) == [2])
        #expect(model.archived.first?.currentValue == 50)
        #expect(model.archived.first?.assetGain == 0)
        #expect(model.investments.contains { !$0.isActive })
    }

    @Test func archivedSummariesInAnotherCurrencyAreRejected() async {
        let transport = PortfolioReadTransport()
        await transport.returnWrongArchiveCurrency()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        #expect(model.archived.isEmpty)
        #expect(model.archiveSummary == nil)
        #expect(model.errors["archive"] != nil)
        #expect(model.active.count == 1)
    }

    @Test func assetPageTotalsAreTheServerGroupOrSingleClassEntries() async throws {
        let model = PortfolioModel(service: portfolioReadClient(PortfolioReadTransport()))
        await model.load(currency: "EUR")
        #expect(model.holdingTotals(assetClasses: [.stock, .etf]).totalPortfolioValue == 321)
        #expect(model.holdingTotals(assetClasses: [.etf, .stock]).netReturnWithDividends == 17)
        #expect(model.holdingTotals(assetClasses: [.crypto]).totalPortfolioValue == 12)
        #expect(model.holdingTotals(assetClasses: [.metals]) == .empty)
        #expect(model.holdingTotals(assetClasses: [.realEstate]).monthlyRentRateMissing)
    }

    @Test func rentAndFeeFiguresAreReadFromTheServerSummary() throws {
        var row = portfolioHoldingWire(id: 3)
        row["monthlyRent"] = .number(850)
        row["feesAndTaxes"] = .number(12)
        row["propertyReturn"] = .number(Decimal(string: "99.5")!)
        let property = try row.decode(PortfolioHolding.self)
        #expect(property.monthlyRent == 850)
        #expect(property.feesAndTaxes == 12)
        #expect(property.propertyReturn == Decimal(string: "99.5"))
        // No stored rate for the rent's currency: the server sends null, never a constant.
        row["monthlyRent"] = .null
        #expect(try row.decode(PortfolioHolding.self).monthlyRent == nil)
        #expect(property.accountTotals.map(\.accountId) == [42, nil])
    }

    @Test func changedCurrencyFailureCannotLabelOldAmountsWithTheNewCurrency() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        await transport.returnWrongCurrency()
        await model.load(currency: "USD")
        #expect(model.currency == "USD")
        #expect(model.summary == nil)
        #expect(model.active.isEmpty)
        #expect(model.performance == nil)
        #expect(model.error != nil)
    }

    @Test func delayedOldCurrencyResponseCannotReplaceNewerScope() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await transport.pauseNext("summary")
        let old = Task { await model.load(currency: "EUR") }
        await transport.waitForPause()
        await model.load(currency: "USD")
        await transport.release()
        await old.value
        #expect(model.currency == "USD")
        #expect(model.summary?.currency == "USD")
        #expect(model.performance?.currency == "USD")
        #expect(!model.isFetching)
    }

    @Test func urlPeriodAndFxStateReuseTheRightPerformanceCacheWithoutRefetchingHoldings() async throws {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        let initialRoute = try #require(NativeRoute("/portfolio?period=all&fx_neutral=true"))
        await model.load(currency: "EUR", route: initialRoute)
        #expect(model.showFxNeutral)
        await model.load(currency: "EUR", period: .oneYear)
        #expect(model.period == .oneYear)
        #expect(model.performance?.startDate == "2025-01-01")
        await model.load(currency: "EUR", period: .all)
        #expect(model.performance?.startDate == "2020-01-01")
        let requests = await transport.requests
        #expect(
            requests.filter { $0.url.path == "/api/info/portfolio-summary" && portfolioQuery($0, "active") == nil }
                .count == 1)
        #expect(
            requests.filter { $0.url.path == "/api/info/portfolio-performance" && portfolioQuery($0, "period") == "1m" }
                .count == 1)
        #expect(
            PortfolioPeriod.all.applying(to: initialRoute.setting("period", to: "1y")).value("period") == nil
        )
    }

    @Test func brokerFilteringIncludesPositionAndStandaloneIncomeContributionsWithoutReplayingLots() async throws {
        let model = PortfolioModel(service: portfolioReadClient(PortfolioReadTransport()))
        await model.load(currency: "EUR")
        let holding = try #require(model.active.first)
        #expect(model.metrics(for: holding).returnPercent == Decimal(string: "56.001"))
        #expect(model.brokerSubtotal.currentValue == 100)
        model.brokerFilter = .account(42)
        #expect(model.filteredHoldings.count == 1)
        #expect(model.brokerSubtotal.currentValue == 100)
        #expect(model.brokerSubtotal.gainLoss == 25)
        #expect(model.brokerOptions.map(\.id) == [.account(42), .unassigned])
        #expect(model.metrics(for: holding).returnPercent == 50)
        model.brokerFilter = .unassigned
        #expect(model.filteredHoldings.count == 1)
        #expect(model.brokerSubtotal.gainLoss == 3)
        #expect(model.metrics(for: holding).returnPercent == 0)
        model.brokerFilter = .account(999)
        #expect(model.filteredHoldings.isEmpty)
    }

    @Test func yahooQuotesUseOnlyEligibleConfiguredProviderIdentities() async {
        let transport = PortfolioReadTransport()
        await transport.addProviderIdentityCases()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        #expect(model.quoteSymbols == ["EMPTY-ID-SYMBOL", "REAL.YAHOO"])
        let quotes = await transport.requests.filter { $0.url.path == "/api/market/quote" }
        #expect(quotes.count == 1)
        #expect(quotes.first.flatMap { portfolioQuery($0, "symbols") } == "EMPTY-ID-SYMBOL,REAL.YAHOO")
        #expect(quotes.first.flatMap { portfolioQuery($0, "detail") } == "basic")
    }

    @Test func periodChangesDoNotDuplicateAnInFlightProviderRequestInTheSameSymbolScope() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        await transport.pauseNext("quotes")
        let quote = Task { await model.refreshQuotes(force: true) }
        await transport.waitForPause()
        await model.load(currency: "EUR", period: .oneYear)
        #expect(await transport.requests.filter { $0.url.path == "/api/market/quote" }.count == 2)
        await transport.release()
        await quote.value
        #expect(!model.isQuotesLoading)
        #expect(model.quotes.first?.price == Decimal(string: "1.25"))
        #expect(model.quotes.first?.currency == "USD")
    }

    @Test func completeHistoryUses1000RowPagesAndMakesMutationsAvailableOnlyAfterAllPages() async throws {
        let transport = PortfolioReadTransport(transactionCount: 2001)
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        #expect(await model.loadHistory(investmentId: 7))
        #expect(model.historyComplete)
        #expect(model.transactions.count == 2001)
        #expect(model.transactions.last?.id == 2001)
        let requests = await transport.requests.filter { $0.url.path.hasSuffix("/transactions") }
        #expect(requests.map { portfolioQuery($0, "offset") } == ["0", "1000", "2000"])
        #expect(requests.allSatisfy { portfolioQuery($0, "limit") == "1000" })
    }

    @Test func emptyDuplicateWrongInvestmentOrChangingPagesCannotProduceACompleteHistory() async {
        for mode in ["empty", "duplicate", "wrong-investment", "changed-total"] {
            let transport = PortfolioReadTransport(transactionCount: 1001)
            await transport.setHistoryMode(mode)
            let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
            #expect(!(await model.loadHistory(investmentId: 7)))
            #expect(!model.historyComplete)
            #expect(model.transactions.isEmpty)
            #expect(model.historyError != nil)
        }
    }

    @Test func independentHistoryDoesNotChangeTheSelectedDetailOrCancelOtherInvestments() async throws {
        let model = PortfolioModel(service: portfolioReadClient(PortfolioReadTransport(transactionCount: 3)))
        await model.openDetail(id: 1)
        async let first = model.independentHistory(investmentId: 7)
        async let second = model.independentHistory(investmentId: 8)
        let rows = try await (first, second)
        #expect(rows.0.allSatisfy { $0.investmentId == 7 })
        #expect(rows.1.allSatisfy { $0.investmentId == 8 })
        #expect(model.selectedInvestmentId == 1)
        #expect(model.historyInvestmentId == 1)
        #expect(model.transactions.allSatisfy { $0.investmentId == 1 })
    }

    @Test func hiddenWidgetsAndOfflineStateDoNotConsumeNewsOrQuoteProviders() async {
        let transport = PortfolioReadTransport()
        await transport.hideRemoteWidgets()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        #expect(
            await transport.requests.allSatisfy {
                !["/api/market/quote", "/api/market/news", "/api/investments/exposure"].contains($0.url.path)
            })
        model.isOnline = false
        await model.refreshQuotes(force: true)
        await model.loadNews(force: true)
        await model.refreshPrices()
        #expect(await transport.requests.allSatisfy { $0.url.path != "/api/investments/refresh-prices" })
    }

    @Test func widgetCasPreservesOtherPagesAndLateReadCannotUndoSavedVisibility() async throws {
        let transport = PortfolioReadTransport()
        let widgets = PortfolioWidgetsModel(service: portfolioReadClient(transport))
        await widgets.load()
        await transport.pauseNext("widgets")
        let old = Task { await widgets.load() }
        await transport.waitForPause()
        await widgets.setVisible("news", false)
        await transport.release()
        await old.value
        #expect(!widgets.isVisible("news"))
        #expect(widgets.error == nil)
        #expect(await transport.widgetValue["budgetTax"]?["summaryCards"] == .bool(false))
        #expect(await transport.widgetValue["unknownPage"]?["unknownWidget"] == .bool(true))
        let write = try #require(
            await transport.requests.first { $0.url.path == "/api/settings/widget_visibility" && $0.method == .put })
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(write.body))
        #expect(body["expected"]?["exists"] == .bool(true))
        #expect(body["expected"]?["value"]?["portfolio"]?["news"] == nil)
        #expect(PortfolioWidgetsModel.definitions.count == 11)
    }

    @Test func legacyWidgetBaselineRemainsAnOpaqueStringWhileTheValueIsAnObject() async {
        let transport = PortfolioReadTransport()
        await transport.useLegacyWidgetToken()
        let model = PortfolioWidgetsModel(service: portfolioReadClient(transport))
        await model.load()
        #expect(model.isLoaded)
        await model.setVisible("news", false)
        #expect(model.error == nil)
        #expect(!model.isVisible("news"))
        #expect(await transport.widgetValue["unknownPage"]?["unknownWidget"] == .bool(true))
    }

    @Test func lostWidgetAcknowledgementReadsTheCommittedValueAndCanSaveAgain() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioWidgetsModel(service: portfolioReadClient(transport))
        await model.load()
        await transport.loseWidgetAcknowledgement()
        await model.setVisible("news", false)
        #expect(model.error != nil)
        #expect(!model.isVisible("news"))
        await model.setVisible("news", true)
        #expect(model.error == nil)
        #expect(model.isVisible("news"))
    }

    @Test func priceRefreshProvenanceDoesNotRepriceLocallyAndReloadsAfterUnknownAcknowledgement() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        var receipts: [PortfolioPriceRefreshReceipt] = []
        var valueAtReceipt: Decimal?
        model.didPriceRefresh = {
            receipts.append($0)
            valueAtReceipt = model.summary?.totals.totalPortfolioValue
        }
        await transport.losePriceAcknowledgement()
        await model.refreshPrices()
        #expect(receipts.count == 1 && receipts.first?.error == model.priceError)
        #expect(receipts.first?.result == nil && receipts.first?.offline == false)
        #expect(valueAtReceipt == 100)
        #expect(model.priceError != nil)
        #expect(model.summary?.totals.totalPortfolioValue == 101)
        #expect(!model.isRefreshingPrices)
        #expect(model.priceNoticeRevision == 1)
        #expect(model.historyComplete == false)
    }

    @Test func identicalPriceRefreshCompletionsEachPublishANoticeAndOfflineAttemptsDoNot() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        var receipts: [PortfolioPriceRefreshReceipt] = []
        model.didPriceRefresh = { receipts.append($0) }
        #expect(model.usesExternalPriceNotices)
        await model.load(currency: "EUR")
        await model.refreshPrices()
        let firstResult = model.priceRefreshResult
        #expect(firstResult?.staleCount == 1)
        #expect(model.priceNoticeRevision == 1)
        await model.refreshPrices()
        #expect(model.priceRefreshResult == firstResult)
        #expect(model.priceNoticeRevision == 2)
        #expect(receipts.count == 2 && receipts[0] == receipts[1])
        model.isOnline = false
        await model.refreshPrices()
        #expect(model.priceNoticeRevision == 2)
        #expect(receipts.count == 2)
    }

    @Test func failedSameCurrencyRefreshExposesErrorWithRetainedServerFiguresAndClearsOnRetry() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        #expect(model.brokerFilterStatusKey == "portfolio.brokerFilter.loading")
        await model.load(currency: "EUR")
        #expect(model.error == nil)
        #expect(model.brokerFilterStatusKey == nil)
        await transport.failSummaryReads(true)
        await model.refreshAfterWrite()
        #expect(model.summary?.totals.totalPortfolioValue == 100)
        #expect(model.error != nil)
        #expect(!model.isLoading)
        #expect(model.brokerFilterStatusKey == "portfolio.brokerFilter.unavailable")
        await transport.failSummaryReads(false)
        await model.load(currency: "EUR", force: true)
        #expect(model.error == nil)
        #expect(model.summary?.totals.totalPortfolioValue == 100)
        #expect(model.brokerFilterStatusKey == nil)
    }

    @Test func netWorthPriceRefreshInvalidatesThePreviouslyLoadedPortfolioCache() async {
        let transport = PortfolioReadTransport()
        let screens = PortfolioScreens(client: portfolioReadClient(transport))
        await screens.model.load(currency: "EUR")
        #expect(screens.model.summary?.totals.totalPortfolioValue == 100)
        await screens.netWorth.load(currency: "EUR", pageSize: 2, route: NativeRoute(path: "/portfolio/net-worth"))
        await screens.netWorth.refreshPrices(route: NativeRoute(path: "/portfolio/net-worth"))
        #expect(screens.dataRevision == 1)
        #expect(screens.netWorth.data?.current.netWorth == 101)
        await screens.model.load(currency: "EUR")
        #expect(screens.model.summary?.totals.totalPortfolioValue == 101)
    }

    @Test func portfolioRefreshInvalidatesNetWorthEvenAfterALostAcknowledgement() async {
        let transport = PortfolioReadTransport()
        let screens = PortfolioScreens(client: portfolioReadClient(transport))
        let route = NativeRoute(path: "/portfolio/net-worth")
        await screens.netWorth.load(currency: "EUR", pageSize: 2, route: route)
        #expect(screens.netWorth.data?.current.netWorth == 100)
        await transport.losePriceAcknowledgement()
        await screens.model.refreshPrices()
        #expect(screens.model.priceError != nil)
        #expect(screens.dataRevision == 1)
        await screens.netWorth.load(currency: "EUR", pageSize: 2, route: route)
        #expect(screens.netWorth.data?.current.netWorth == 101)
    }

    @Test func netWorthRefreshReadsCommittedValuesAfterALostAcknowledgementAndKeepsTheError() async {
        let transport = PortfolioReadTransport()
        let screens = PortfolioScreens(client: portfolioReadClient(transport))
        let route = NativeRoute(path: "/portfolio/net-worth")
        await screens.netWorth.load(currency: "EUR", pageSize: 2, route: route)
        await transport.losePriceAcknowledgement()
        await screens.netWorth.refreshPrices(route: route)
        #expect(screens.netWorth.data?.current.netWorth == 101)
        #expect(screens.netWorth.notice?.kind == .error)
        #expect(screens.netWorth.pricesError != nil)
        #expect(screens.dataRevision == 1)
    }

    @Test func failedRawInvestmentRefreshExposesMainErrorDespiteSuccessfulSummaryAndClearsOnRetry() async {
        let transport = PortfolioReadTransport()
        let model = PortfolioModel(service: portfolioReadClient(transport), now: { PlannedFixture.today })
        await model.load(currency: "EUR")
        #expect(model.investment(id: 1)?.name == "Synthetic holding 1")
        await transport.failInvestmentReads(true)
        await model.refreshAfterWrite()
        #expect(model.summary?.totals.totalPortfolioValue == 100)
        #expect(model.errors["summary"] == nil)
        #expect(model.error == model.errors["investments"])
        #expect(model.error != nil)
        #expect(model.investment(id: 1) == nil)
        #expect(!model.isLoading)
        await transport.failInvestmentReads(false)
        await model.load(currency: "EUR", force: true)
        #expect(model.error == nil)
        #expect(model.investment(id: 1)?.name == "Synthetic holding 1")
    }

    @Test func freshnessIsLimitedByOldestLiveQuoteAndManualPricesNeverBecomeStale() throws {
        var first = portfolioHoldingWire(id: 1)
        first["price_updated_at"] = .string("2026-10-11T12:00:00Z")
        var second = portfolioHoldingWire(id: 2)
        second["price_updated_at"] = .string("2026-10-12T12:00:00.000Z")
        var manual = portfolioHoldingWire(id: 3)
        manual["price_provider"] = .string("manual")
        manual["price_updated_at"] = .null
        let values = try [first, second, manual].map { try $0.decode(PortfolioHolding.self) }
        #expect(PortfolioPriceFreshness.aggregate(values) == .asOf("2026-10-11T12:00:00.000Z"))
        #expect(!PortfolioPriceFreshness.isStale(values[2], now: Date(timeIntervalSince1970: 1_791_892_800)))
        second["price_updated_at"] = .string("unreadable")
        #expect(
            try PortfolioPriceFreshness.aggregate([values[0], second.decode(PortfolioHolding.self)]) == .notFetched)
        #expect(PortfolioPriceFreshness.aggregate([values[2]]) == .none)
    }
}

private func portfolioReadClient(_ transport: PortfolioReadTransport) -> APIClient {
    APIClient(baseURL: { URL(string: "http://127.0.0.1:3200") }, transport: transport, maxRetries: 0)
}
private func portfolioQuery(_ request: APIRequest, _ name: String) -> String? {
    URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
}

private actor PortfolioReadTransport: APITransport {
    var requests: [APIRequest] = []
    var widgetValue: TaxValue = .object([
        "portfolio": .object([:]), "budgetTax": .object(["summaryCards": .bool(false)]),
        "unknownPage": .object(["unknownWidget": .bool(true)]),
    ])
    private let transactionCount: Int
    private var historyMode = "normal"
    private var missingMoney = false
    private var wrongArchiveCurrency = false
    private var failedSummaryReads = false
    private var failedInvestmentReads = false
    private var wrongCurrency = false
    private var legacyWidgetToken: TaxValue?
    private var lostWidgetAck = false
    private var lostPriceAck = false
    private var currentValue: Decimal = 100
    private var rawInvestments = [portfolioInvestmentWire(id: 1), portfolioInvestmentWire(id: 2, active: false)]
    private var pausedPath: String?
    private var paused = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    init(transactionCount: Int = 3) { self.transactionCount = transactionCount }
    func omitRequiredMoney() { missingMoney = true }
    func returnWrongArchiveCurrency() { wrongArchiveCurrency = true }
    func failSummaryReads(_ fail: Bool) { failedSummaryReads = fail }
    func failInvestmentReads(_ fail: Bool) { failedInvestmentReads = fail }
    func returnWrongCurrency() { wrongCurrency = true }
    func setHistoryMode(_ mode: String) { historyMode = mode }
    func losePriceAcknowledgement() { lostPriceAck = true }
    func useLegacyWidgetToken() { legacyWidgetToken = .string("{\"synthetic-legacy-widget-token\":true}") }
    func loseWidgetAcknowledgement() { lostWidgetAck = true }
    func hideRemoteWidgets() {
        widgetValue["portfolio"] = .object(["ticker": .bool(false), "news": .bool(false), "exposure": .bool(false)])
    }
    func addProviderIdentityCases() {
        for (id, provider, identity, symbol, visible) in [
            (3, "manual", "UNRELATED", "MANUAL", true), (4, "coingecko", "bitcoin", "BTC", true),
            (5, "yahoo", "", "EMPTY-ID-SYMBOL", true), (6, "yahoo", "HIDDEN", "HIDDEN", false),
            (7, "yahoo", "  ", "WHITESPACE-ID", true),
        ] {
            var row = portfolioInvestmentWire(id: id)
            row["price_provider"] = .string(provider)
            row["price_provider_id"] = .string(identity)
            row["symbol"] = .string(symbol)
            row["show_in_ticker"] = .bool(visible)
            rawInvestments.append(row)
        }
    }
    func pauseNext(_ path: String) {
        pausedPath = path
        paused = false
    }
    func waitForPause() async { if !paused { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    private func waitIfNeeded(_ path: String) async {
        if pausedPath == path {
            pausedPath = nil
            paused = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let requestedCurrency = portfolioQuery(request, "currency") ?? "EUR"
        let currency = wrongCurrency ? "GBP" : requestedCurrency
        let data: TaxValue
        switch request.url.path {
        case "/api/info/net-worth":
            let limit = portfolioQuery(request, "limit").flatMap(Int.init)
            let offset = portfolioQuery(request, "offset").flatMap(Int.init) ?? 0
            let snapshot: TaxValue = .object([
                "date": .string("2026-10-13"), "liquid": .number(0), "liabilities": .number(0),
                "investments": .number(currentValue), "netWorth": .number(currentValue),
            ])
            var fields: [String: TaxValue] = [
                "current": .object([
                    "currency": .string(currency), "liquid": .number(0), "liabilities": .number(0),
                    "investments": .number(currentValue), "netWorth": .number(currentValue),
                ]), "monthlyChange": .number(0), "monthlyChangePercent": .number(0),
                "unconvertedCurrencies": .array([]),
                "snapshots": .array(offset == 0 ? [snapshot] : []),
            ]
            if let limit {
                fields["snapshotsLimit"] = .number(Decimal(limit))
                fields["snapshotsOffset"] = .number(Decimal(offset))
                fields["snapshotsTotal"] = .number(1)
            }
            data = .object(fields)
        case "/api/info/exchange-rates":
            data = .object([
                "total_rates": .number(0), "rates": .array([]), "fallback_rates": .object(["EUR": .number(1)]),
                "source": .string("synthetic"), "is_stale": .bool(false),
            ])
        case "/api/info/portfolio-summary":
            if failedSummaryReads { throw APIError.network("Synthetic summary read failure") }
            let all = portfolioQuery(request, "active") == "false"
            var active = portfolioHoldingWire(id: 1, currency: currency)
            active["currentValue"] = .number(currentValue)
            if missingMoney { active["currentValue"] = nil }
            let canonicalArchive = portfolioHoldingWire(
                id: 2, active: false, currency: all && wrongArchiveCurrency ? "USD" : currency, currentValue: 50)
            let object: [String: TaxValue] = [
                "currency": .string(currency), "computed_at": .string("2026-10-13T12:00:00Z"),
                "totals": portfolioTotalsWire(value: all ? 150 : currentValue),
                "summaries": .array(all ? [active, canonicalArchive] : [active]),
                "byAccount": active["byAccount"]!, "accountTotals": active["accountTotals"]!,
                "byAssetClass": .array([portfolioAssetTotalsWire(["assetClass": .string("crypto"), "value": .number(12)])]),
                "byAssetGroup": .array([
                    portfolioAssetTotalsWire(
                        ["group": .string("stocks_etfs"), "assetClasses": .array([.string("stock"), .string("etf")]),
                            "value": .number(321), "netReturnWithDividends": .number(17)]),
                    portfolioAssetTotalsWire(
                        ["group": .string("real_estate"), "assetClasses": .array([.string("real_estate")]),
                            "value": .number(0), "rentMissing": .bool(true)]),
                ]),
                "firstInvestmentDate": .string("2024-02-03"),
            ]
            data = .object(object)
            if !all { await waitIfNeeded("summary") }
        case "/api/investments":
            if failedInvestmentReads { throw APIError.network("Synthetic investment read failure") }
            let offset = portfolioQuery(request, "offset").flatMap(Int.init) ?? 0
            let limit = portfolioQuery(request, "limit").flatMap(Int.init) ?? 500
            data = .object([
                "items": .array(Array(rawInvestments.dropFirst(offset).prefix(limit))),
                "total": .number(Decimal(rawInvestments.count)), "limit": .number(Decimal(limit)),
                "offset": .number(Decimal(offset)),
            ])
        case let path where path.hasPrefix("/api/investments/") && path.hasSuffix("/transactions"):
            let id = Int(path.split(separator: "/")[2])!
            let offset = portfolioQuery(request, "offset").flatMap(Int.init) ?? 0
            let limit = portfolioQuery(request, "limit").flatMap(Int.init) ?? 1000
            var rows = (offset..<min(transactionCount, offset + limit)).map {
                portfolioTransactionWire(id: $0 + 1, investmentId: id)
            }
            var total = transactionCount
            if offset > 0 {
                if historyMode == "empty" { rows = [] }
                if historyMode == "duplicate", !rows.isEmpty {
                    rows[0] = portfolioTransactionWire(id: 1, investmentId: id)
                }
                if historyMode == "wrong-investment", !rows.isEmpty {
                    rows[0] = portfolioTransactionWire(id: offset + 1, investmentId: id + 1)
                }
                if historyMode == "changed-total" { total += 1 }
            }
            data = .object([
                "items": .array(rows), "total": .number(Decimal(total)), "limit": .number(Decimal(limit)),
                "offset": .number(Decimal(offset)),
            ])
        case "/api/accounts": data = .object(["items": .array([]), "total": .number(0), "links": .array([])])
        case "/api/info/portfolio-performance":
            data = portfolioPerformanceWire(currency: currency, period: portfolioQuery(request, "period") ?? "all")
        case "/api/info/portfolio-performance/by-broker":
            data = .object([
                "currency": .string(currency), "startDate": .string("2020-01-01"), "endDate": .string("2026-10-13"),
                "dates": .array([]), "series": .array([]), "rows": .array([]),
            ])
        case "/api/investments/exposure": data = portfolioExposureWire(currency: currency)
        case "/api/market/quote":
            let rows = (portfolioQuery(request, "symbols") ?? "").split(separator: ",").map { symbol in
                TaxValue.object([
                    "symbol": .string(String(symbol)), "currency": .string("USD"),
                    "price": .number(Decimal(string: "1.25")!), "change": .number(0), "changePercent": .number(0),
                ])
            }
            data = .object(["items": .array(rows), "total": .number(Decimal(rows.count))])
            await waitIfNeeded("quotes")
        case "/api/market/news": data = .object(["items": .array([]), "total": .number(0)])
        case "/api/investments/refresh-prices":
            currentValue = 101
            if lostPriceAck { throw APIError.network("Synthetic lost price acknowledgement") }
            data = .object([
                "updated": .number(1), "total": .number(1),
                "priceSources": .object(["1": .string("historical_fallback")]),
            ])
        case "/api/settings/widget_visibility":
            if request.method == .put {
                let body = try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
                guard body["expected"] == .object(["exists": .bool(true), "value": legacyWidgetToken ?? widgetValue])
                else {
                    throw APIError.invalidRequest("Synthetic stale widget baseline")
                }
                widgetValue = body["value"]!
                legacyWidgetToken = nil
                if lostWidgetAck {
                    lostWidgetAck = false
                    throw APIError.network("Synthetic lost widget acknowledgement")
                }
            }
            data = .object([
                "key": .string("widget_visibility"), "value": widgetValue,
                "expected": .object(["exists": .bool(true), "value": legacyWidgetToken ?? widgetValue]),
            ])
            if request.method == .get { await waitIfNeeded("widgets") }
        default: throw APIError.invalidRequest("Unexpected synthetic path \(request.url.path)")
        }
        return APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
}

private func portfolioHoldingWire(id: Int, active: Bool = true, currency: String = "EUR", currentValue: Decimal = 100)
    -> TaxValue
{
    var row: TaxValue = .object([
        "id": .number(Decimal(id)), "name": .string("Synthetic holding \(id)"), "symbol": .string("SYN"),
        "assetClass": .string("stock"),
        "is_active": .bool(active), "currency": .string(currency), "originalCurrency": .string("USD"),
        "created_at": .string("2026-01-01T00:00:00Z"), "updated_at": .string("2026-01-01T00:00:00Z"),
        "price_provider": .string("yahoo"), "price_provider_id": .string("REAL.YAHOO"),
        "price_updated_at": .string("2026-10-13T12:00:00Z"),
        "cadastral_income": .string("987.654321"), "municipality_tax_rate": .null,
        "fullyAssigned": .bool(true), "oversold": .bool(false), "usedFallbackRate": .bool(false),
        "byAccount": .array([
            portfolioPartitionWire(account: 42, kind: "position", value: 100, invested: 50, gain: 20),
            portfolioPartitionWire(account: 42, kind: "non_position", value: 0, invested: 0, gain: 5),
            portfolioPartitionWire(account: nil, kind: "non_position", value: 0, invested: 0, gain: 3),
        ]),
        // The server's per-account sums of every contribution kind (the broker filter's figures).
        "accountTotals": .array([
            portfolioAccountTotalsWire(account: 42, value: 100, invested: 50, gain: 25),
            portfolioAccountTotalsWire(account: nil, value: 0, invested: 0, gain: 3),
        ]),
    ])
    for key in [
        "totalUnits", "currentPrice", "interestRate", "totalInvested", "totalBuyCost", "totalSellProceeds",
        "currentValue", "totalFees", "totalTaxes", "totalDividends", "totalIncome", "avgCostBasis", "realizedGain",
        "unrealizedGain", "totalGain", "gainLoss", "gainLossPercent", "assetGain", "fxGain", "nativeCurrentValue",
        "accruedInterest", "projectedAnnualInterest", "totalAppreciation",
    ] { row[key] = .number(0) }
    row["totalUnits"] = .number(Decimal(string: "0.123456789012345678901")!)
    row["currentValue"] = .number(currentValue)
    row["totalInvested"] = .number(50)
    row["gainLoss"] = .number(28)
    row["gainLossPercent"] = .number(Decimal(string: "56.001")!)
    return row
}
private func portfolioAccountTotalsWire(account: Int?, value: Decimal, invested: Decimal, gain: Decimal)
    -> TaxValue
{
    .object([
        "account_id": account.map { .number(Decimal($0)) } ?? .null,
        "assignment": .string(account == nil ? "unassigned" : "account"), "oversold": .bool(false),
        "currentValue": .number(value), "totalInvested": .number(invested), "realizedGain": .number(0),
        "unrealizedGain": .number(0), "gainLoss": .number(gain),
    ])
}
/// A `byAssetGroup` / `byAssetClass` entry: zero figures except the ones named in `overrides`.
private func portfolioAssetTotalsWire(_ overrides: [String: TaxValue]) -> TaxValue {
    var object: [String: TaxValue] = [
        "holdingCount": .number(1), "usedFallbackRate": .bool(false),
        "monthlyRentRateMissing": .bool(overrides["rentMissing"] == .bool(true)),
    ]
    for key in [
        "totalPortfolioValue", "totalInvested", "totalGainLoss", "totalRealizedGain", "totalUnrealizedGain",
        "totalIncome", "totalDividends", "totalInKindIncome", "totalFees", "totalTaxes", "totalFeesAndTaxes",
        "netReturnExcludingIncome", "netReturnWithDividends", "totalAppreciation", "totalPropertyReturn",
        "totalAccruedInterest", "totalProjectedAnnualInterest", "valueWeightedInterestRate", "estimatedMonthlyRent",
    ] { object[key] = .number(0) }
    if let value = overrides["value"] { object["totalPortfolioValue"] = value }
    if let value = overrides["netReturnWithDividends"] { object["netReturnWithDividends"] = value }
    for key in ["assetClass", "group", "assetClasses"] { if let value = overrides[key] { object[key] = value } }
    return .object(object)
}
private func portfolioPartitionWire(account: Int?, kind: String, value: Decimal, invested: Decimal, gain: Decimal)
    -> TaxValue
{
    .object([
        "account_id": account.map { .number(Decimal($0)) } ?? .null,
        "assignment": .string(account == nil ? "unassigned" : "account"), "contribution_kind": .string(kind),
        "oversold": .bool(false), "currentValue": .number(value), "totalInvested": .number(invested),
        "realizedGain": .number(0), "unrealizedGain": .number(0), "gainLoss": .number(gain),
    ])
}
private func portfolioTotalsWire(value: Decimal) -> TaxValue {
    var result: TaxValue = .object(["usedFallbackRate": .bool(false)])
    for key in [
        "totalPortfolioValue", "totalInvested", "totalGainLoss", "totalRealizedGain", "totalUnrealizedGain",
        "totalGain", "totalIncome", "totalFees", "totalTaxes", "totalAssetGain", "totalFxGain", "totalReturnPct",
    ] { result[key] = .number(0) }
    result["totalPortfolioValue"] = .number(value)
    return result
}
private func portfolioInvestmentWire(id: Int, active: Bool = true) -> TaxValue {
    .object([
        "id": .number(Decimal(id)), "name": .string("Synthetic holding \(id)"), "symbol": .string("UNRELATED.SYMBOL"),
        "asset_class": .string("stock"), "currency": .string("USD"), "is_active": .bool(active),
        "price_provider": .string("yahoo"), "price_provider_id": .string("REAL.YAHOO"), "show_in_ticker": .bool(true),
        "created_at": .string("2026-01-01T00:00:00Z"), "updated_at": .string("2026-01-01T00:00:00Z"),
    ])
}
private func portfolioTransactionWire(id: Int, investmentId: Int) -> TaxValue {
    .object([
        "id": .number(Decimal(id)), "investment_id": .number(Decimal(investmentId)), "type": .string("buy"),
        "date": .string("2026-01-01"), "amount": .number(Decimal(string: "0.123456789012345678901")!),
        "currency": .string("USD"), "is_recurring": .bool(false), "income_recognition_role": .string("standard"),
        "dividend_amount_convention": .string("unknown"), "created_at": .string("2026-01-01T00:00:00Z"),
        "updated_at": .string("2026-01-01T00:00:00Z"),
    ])
}
private func portfolioPerformanceWire(currency: String, period: String) -> TaxValue {
    .object([
        "currency": .string(currency), "start_date": .string(period == "all" ? "2020-01-01" : "2025-01-01"),
        "end_date": .string("2026-10-13"), "snapshots": .array([]), "metrics": .null,
        "heatmap": .object(["years": .array([]), "data": .object([:]), "maxAbsPct": .number(0)]),
        "breakdownSummary": .array([]),
    ])
}
private func portfolioExposureWire(currency: String) -> TaxValue {
    let dimension: TaxValue = .object([
        "rows": .array([]), "classifiedValue": .number(0), "classifiedWeightPercent": .number(0),
        "unclassifiedValue": .number(100), "unclassifiedWeightPercent": .number(100),
    ])
    return .object([
        "currency": .string(currency), "computedAt": .string("2026-10-13T12:00:00Z"), "totalValue": .number(100),
        "uncoveredValue": .number(100), "uncoveredWeightPercent": .number(100), "coveredCashValue": .number(0),
        "coveredCashWeightPercent": .number(0), "fundSources": .array([]), "issuer": dimension, "sector": dimension,
        "issuerCountry": dimension, "warnings": .array([]), "scopeNotes": .array([]),
    ])
}
