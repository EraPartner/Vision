import Foundation
import Testing

@testable import VisionNativeCore

private let insightMonthsJSON =
    #"{"months":[{"month":9,"year":2026,"period_start":"2026-09-01","period_end":"2026-09-30","total_spending":-250.12,"total_income":1000.99,"net_amount":750.87,"transaction_count":4},{"month":10,"year":2026,"period_start":"2026-10-01","period_end":"2026-10-31","total_spending":0,"total_income":0,"net_amount":0,"transaction_count":0}]}"#
private let insightPaceJSON =
    #"{"past_6_months":{"avg_monthly_spending":500,"months_counted":6},"current_month":{"daily_data":[{"date":"2026-10-01","spending":0.1,"income":100},{"date":"2026-10-03","spending":0.2,"income":0}],"total_spending":0.3,"days_elapsed":3,"days_in_month":31},"comparison":{"projected_monthly_total":3.1,"avg_monthly_spending":500}}"#
private let insightForecastJSON =
    #"{"actual":[{"date":"2026-10-01","net":10,"cumulative":10},{"date":"2026-10-02","net":null,"cumulative":null}],"methods":[{"id":"ensemble_imse","label":"Ensemble","daily":[{"date":"2026-10-02","value":20}],"cumulative":[{"date":"2026-10-02","value":30}],"bands":{"p25":[{"date":"2026-10-02","value":5}],"p75":[{"date":"2026-10-02","value":35}]},"cumulative_bands":{"p25":[{"date":"2026-10-02","value":15}],"p75":[{"date":"2026-10-02","value":45}]},"error":null}],"scheduled_actual":[{"date":"2026-10-02","net":5}],"planned":[{"date":"2026-10-02","net":7}],"diagnostics":null,"currency":"EUR","history_months":12,"include_planned":true,"month":"2026-10"}"#

private func insightFixture<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}

@Suite("Home and Insights financial contracts")
struct InsightsTests {
    @Test func malformedSettingsFieldsUseTheWebMigrationDefaults() {
        let settings: JSONValue = .object([
            "exclusionScope": .string("unknown"),
            "excludedCategoryIds": .array([.int(4), .string("bad")]), "excludeHiddenCategories": .string("bad"),
        ])
        #expect(InsightExclusions.resolve(settings: settings, scope: "dashboard", hiddenIds: [9]).categoryIds == [9])
    }
    @Test func financialJSONRetainsDecimalPrecision() throws {
        let json = insightMonthsJSON.replacingOccurrences(
            of: "1000.99", with: "1000.1234567890123456789")
        let data = try insightFixture(InsightMonthlySummary.self, json)
        #expect(data.latest?.total_income == Decimal(string: "1000.1234567890123456789"))
        #expect(data.latest?.id == "2026-09")  // An empty current month does not replace the latest activity.
    }

    @Test func heroFillsMissingDaysAndAddsDecimalsExactly() throws {
        let pace = try insightFixture(HomeSpendingPace.self, insightPaceJSON)
        #expect(
            pace.cumulativeSpending.map(\.value) == [
                0, Decimal(string: "0.1")!, Decimal(string: "0.1")!, Decimal(string: "0.3")!,
            ])
        #expect(pace.income == 100)
    }

    @Test func exclusionsRespectScopeAndResolveHiddenHierarchyNodes() {
        let settings: JSONValue = .object([
            "exclusionScope": .string("statistics"),
            "excludedCategoryIds": .array([.int(4), .int(2), .int(4)]),
            "excludedRecipientIds": .array([.int(7)]), "excludeHiddenCategories": .bool(true),
        ])
        #expect(
            InsightExclusions.resolve(settings: settings, scope: "dashboard", hiddenIds: [9]).isEmpty)
        let exclusions = InsightExclusions.resolve(
            settings: settings, scope: "statistics", hiddenIds: [9, 2])
        #expect(exclusions.categoryIds == [2, 4, 9])
        #expect(exclusions.recipientIds == [7])
        #expect(
            exclusions.queryItems.filter { $0.name == "excluded_category_ids" }.map(\.value) == [
                "2", "4", "9",
            ])
    }

    @Test func widgetEditsPreserveOtherPagesAndUnknownFutureWidgets() {
        var visibility = InsightWidgetVisibility(
            .object([
                "statistics": .object(["rhythm": .bool(false)]),
                "dashboard": .object(["futureWidget": .bool(false)]),
            ]))
        visibility.set("hero", visible: false, page: "dashboard")
        #expect(visibility.pages["dashboard"]?["futureWidget"] == .bool(false))
        #expect(visibility.pages["statistics"]?["rhythm"] == .bool(false))
        visibility.reset(page: "dashboard")
        #expect(visibility.pages["dashboard"] == nil)
        #expect(visibility.pages["statistics"]?["rhythm"] == .bool(false))
        #expect(visibility.isVisible(InsightWidget.home.first { $0.id == "hero" }!, page: "dashboard"))
        #expect(
            !visibility.isVisible(InsightWidget.home.first { $0.id == "statCards" }!, page: "dashboard"))
    }

    @Test func drillsKeepLeapYearBoundariesAndEncodeLabels() throws {
        let json = insightMonthsJSON.replacingOccurrences(of: "2026-09", with: "2024-02")
            .replacingOccurrences(of: "2024-02-30", with: "2024-02-29")
        let month = try insightFixture(InsightMonthlySummary.self, json).months[0]
        let route = InsightsRoutes.drill(
            month: month, type: "expense", categoryIds: [4, 8], label: "Food & cafés")
        #expect(route.value("start_date") == "2024-02-01")
        #expect(route.value("end_date") == "2024-02-29")
        #expect(route.value("category_ids") == "4,8")
        #expect(route.value("transaction_type") == "expense")
        #expect(NativeRoute(route.string)?.value("filter_label") == "Food & cafés")
    }

    @Test func forecastsDisplayServerTotalsWithoutAddingScheduledPaymentsTwice() throws {
        let forecast = try insightFixture(InsightForecast.self, insightForecastJSON)
        let series = forecast.series(
            cumulative: true, visible: ["ensemble_imse"], actualLabel: "Actual")
        #expect(series.first { $0.id == "ensemble_imse" }?.points.first?.value == 30)
        #expect(series.first { $0.id == "ensemble_imse__p25" }?.points.first?.value == 15)
        #expect(series.first { $0.id == "actual" }?.points.count == 1)
        #expect(forecast.series(cumulative: false, visible: [], actualLabel: "Actual").count == 1)
    }

    @Test func cumulativeBandsAreNotInventedFromDailyQuantiles() throws {
        let json = insightForecastJSON.replacingOccurrences(
            of:
                #""cumulative_bands":{"p25":[{"date":"2026-10-02","value":15}],"p75":[{"date":"2026-10-02","value":45}]}"#,
            with: #""cumulative_bands":null"#)
        let forecast = try insightFixture(InsightForecast.self, json)
        #expect(
            forecast.series(cumulative: true, visible: ["ensemble_imse"], actualLabel: "Actual").count
                == 2)
        #expect(
            forecast.series(cumulative: false, visible: ["ensemble_imse"], actualLabel: "Actual").count
                == 4)
    }

    @Test func forecastRoutesPreserveUnrelatedParametersAndValidateWindow() {
        let route = NativeRoute("/?forecastMode=rolling&rollingDays=180&tab=kept")!
        var options = InsightForecastOptions(route: route)
        #expect(options.rollingDays == 180)
        #expect(options.mode == .rolling)
        #expect(options.queryItems.filter { $0.name == "mc_percentiles" }.map(\.value) == ["25", "75"])
        options.mode = .month
        #expect(options.applying(to: route).value("tab") == "kept")
        #expect(InsightForecastOptions(route: NativeRoute("/?rollingDays=999")!).rollingDays == 90)
    }

    @Test func diagnosticPreviewWeightsHaveUniformFloorAndSumToOne() throws {
        let json =
            #"{"history_months":12,"backtest":[{"method_id":"a","label":"A","mae":1,"rmse":1,"mape":null,"months":2,"per_month":[]},{"method_id":"b","label":"B","mae":10,"rmse":10,"mape":null,"months":2,"per_month":[]}]}"#
        let diagnostics = try insightFixture(InsightForecast.Diagnostics.self, json)
        let weights = diagnostics.suggestedWeights
        #expect(abs(weights.values.reduce(0, +) - 1) < Decimal(string: "0.00000000000000000001")!)
        #expect((weights["a"] ?? 0) > (weights["b"] ?? 0))
        #expect((weights["b"] ?? 0) >= Decimal(string: "0.025")!)
    }
}

@Suite("Home query and preference behavior")
@MainActor
struct HomeModelTests {
    @Test func sharedUpcomingFeedsHomeAndDockWithoutDuplicateReadsOrPersistence() async {
        let service = HomeFixtureService()
        let local = HomeSharedLocalFixture()
        let home = HomeModel(service: service, readLocal: local.read, writeLocal: local.write)
        home.useSharedUpcoming()
        let rows = [Self.sharedPayment(1), Self.sharedPayment(2)]
        let notifications = ShellUpcomingPaymentsModel(
            service: HomeUpcomingFixture(rows: rows),
            storage: .init(
                read: { _ in nil },
                write: { _, raw in
                    await local.write("dismissed_upcoming_planned_payments", .string(raw))
                }))
        notifications.didLoadUpcoming = { home.applySharedUpcoming($0) }
        notifications.didChangeDismissals = { home.applyUpcomingDismissals($0) }
        var badge = 0
        notifications.didChangeDockBadge = { badge = $0 }
        await notifications.load()
        await home.appear(settings: .defaults, route: .home)
        #expect(await service.plannedLimits == [200])
        #expect(!local.reads.contains("dismissed_upcoming_planned_payments"))
        #expect(home.upcomingRows.map(\.id) == [1, 2] && badge == 2)
        notifications.dismiss(rows[0])
        await notifications.flushStorage()
        #expect(home.upcomingRows.map(\.id) == [2] && badge == 1)
        #expect(local.writes.count == 1)
        #expect(local.writes.first?.0 == "dismissed_upcoming_planned_payments")
        #expect(home.dismissedUpcoming == Set(["1:2026-10-15"]))
    }

    @Test func lateStandaloneUpcomingResponseCannotReplaceSharedRowsOrDismissals() async {
        let service = HomeFixtureService()
        await service.pauseFirstMonthly()
        let local = HomeSharedLocalFixture()
        let home = HomeModel(service: service, readLocal: local.read, writeLocal: local.write)
        let loading = Task { await home.appear(settings: .defaults, route: .home) }
        await service.waitForPausedMonthly()
        home.applySharedUpcoming([Self.sharedPayment(1), Self.sharedPayment(2)])
        home.applyUpcomingDismissals(["1:2026-10-15"])
        await service.releaseMonthly()
        await loading.value
        #expect(home.upcomingRows.map(\.id) == [2])
        #expect(home.dismissedUpcoming == Set(["1:2026-10-15"]))
        #expect(!local.reads.contains("dismissed_upcoming_planned_payments"))
        #expect(local.writes.isEmpty)
    }

    @Test func inactivityLocalWritesSerializeCapturedValuesAndDrainBeforeRestore() async throws {
        let local = HomeSharedLocalFixture()
        local.pauseWrite = true
        let home = HomeModel(service: HomeFixtureService(), readLocal: local.read, writeLocal: local.write)
        let account = try Self.inactiveAccount()
        let dismiss = Task { await home.dismissInactivity(account) }
        await local.waitForWrite()
        let restore = Task { await home.restoreInactivity() }
        while !home.dismissedAccounts.isEmpty { await Task.yield() }
        var flushed = false
        let draining = Task {
            await home.flushLocalStorage()
            flushed = true
        }
        await Task.yield()
        #expect(local.writes.count == 1 && !flushed)
        local.releaseWrite()
        await dismiss.value
        await restore.value
        await draining.value
        #expect(local.writes.map(\.1) == [.object(["1": .string("2026-01-01")]), .object([:])])
        #expect(flushed && home.dismissedAccounts.isEmpty)
    }

    @Test func delayedInactivityStorageReadCannotUndoAnAcceptedDismissal() async throws {
        let local = HomeSharedLocalFixture()
        local.pauseRead = true
        let home = HomeModel(service: HomeFixtureService(), readLocal: local.read, writeLocal: local.write)
        home.useSharedUpcoming()
        let loading = Task { await home.appear(settings: .defaults, route: .home) }
        await local.waitForRead()
        await home.dismissInactivity(try Self.inactiveAccount())
        local.releaseRead()
        await loading.value
        #expect(home.dismissedAccounts == ["1": "2026-01-01"])
        #expect(local.writes.count == 1)
    }

    private static func sharedPayment(_ id: Int) -> OpenAPI.PlannedTransaction {
        .init(
            id: id, plannedDate: "2026-10-15", amount: -12, isRecurring: true,
            isExecuted: false, executionCount: 0, isActive: true, links: [])
    }
    private static func inactiveAccount() throws -> HomeBankBalances.Account {
        try insightFixture(
            HomeBankBalances.Account.self,
            #"{"account_id":1,"bank_account":"Synthetic","balance":0,"transaction_count":1,"last_transaction":"2026-01-01"}"#
        )
    }

    @Test func invalidationDuringAnOlderRequestCannotOverwriteFreshFinancialData() async {
        let service = HomeFixtureService()
        await service.pauseFirstMonthly()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        let old = Task { await model.appear(settings: .defaults, route: .home) }
        await service.waitForPausedMonthly()
        model.invalidate()
        await service.chooseExclusions([8])
        await model.appear(settings: .defaults, route: .home, force: true)
        #expect(model.monthly?.latest?.total_income == 2000)
        await service.releaseMonthly()
        await old.value
        #expect(model.monthly?.latest?.total_income == 2000)
    }
    @Test func changingExclusionsDoesNotDisplayTotalsFromThePreviousScopeAfterFailure() async {
        let service = HomeFixtureService()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        await service.chooseExclusions([8])
        await service.failMonthly()
        await model.appear(settings: .defaults, route: .home, force: true)
        #expect(model.monthly == nil)
        #expect(model.isFullPageError)
    }
    @Test func recentRowsScanPastExcludedFirstPage() async throws {
        let service = HomeFixtureService()
        let rows = try await HomeModel.recent(
            service: service, exclusions: InsightExclusions(categoryIds: [9]))
        #expect(rows.map(\.id) == [51, 52, 53, 54, 55])
        #expect(await service.requestedOffsets == [0, 50])
    }

    @Test func failedRefreshKeepsLastSuccessfulMoney() async {
        let service = HomeFixtureService()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        #expect(model.monthly?.latest?.total_income == Decimal(string: "1000.99"))
        await service.failMonthly()
        await model.appear(settings: .defaults, route: .home, force: true)
        #expect(model.monthly?.latest?.total_income == Decimal(string: "1000.99"))
        #expect(model.errors["monthly"] != nil)
        #expect(!model.isLoading)
        #expect(!model.isFullPageError)
    }

    @Test func exclusionsFailureDoesNotExposeUnfilteredFinancialTotals() async {
        let service = HomeFixtureService()
        await service.failExclusions()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        #expect(model.monthly == nil)
        #expect(model.isFullPageError)
        #expect(await service.monthlyCalls == 0)
    }

    @Test func failedWidgetSaveRollsBackAndPreservesBaseline() async {
        let service = HomeFixtureService()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        #expect(model.isVisible("hero"))
        await service.failWidgetSave()
        await model.setWidget("hero", visible: false)
        #expect(model.isVisible("hero"))
        #expect(model.widgetError != nil)
        #expect(!model.widgetSavePending)
        #expect(model.widgets.pages["statistics"]?["rhythm"] == .bool(false))
    }

    @Test func successfulWidgetSaveUsesCompareAndSwapAndRetainsOtherPages() async {
        let service = HomeFixtureService()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        await model.setWidget("hero", visible: false)
        #expect(!model.isVisible("hero"))
        #expect(
            await service.lastExpected
                == .object(["exists": .bool(true), "value": .object(["statistics": .object(["rhythm": .bool(false)])])])
        )
        #expect(model.widgets.pages["statistics"]?["rhythm"] == .bool(false))
        await model.resetWidgets()
        #expect(model.isVisible("hero"))
    }

    @Test func repeatedAppearanceReusesFreshQueries() async {
        let service = HomeFixtureService()
        let model = HomeModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: .home)
        let calls = await service.monthlyCalls
        await model.appear(settings: .defaults, route: .home)
        #expect(await service.monthlyCalls == calls)
    }
}

private actor HomeUpcomingFixture: ShellNotificationsService {
    let rows: [OpenAPI.PlannedTransaction]
    init(rows: [OpenAPI.PlannedTransaction]) { self.rows = rows }
    func notificationUpcoming(start: String, end: String) async throws -> [OpenAPI.PlannedTransaction] { rows }
    func notificationExchangeRates() async throws -> OpenAPI.ExchangeRates { throw APIError.backendUnavailable }
    func notificationRefreshExchangeRates() async throws { throw APIError.backendUnavailable }
}

@MainActor private final class HomeSharedLocalFixture {
    var reads: [String] = []
    var writes: [(String, JSONValue)] = []
    var pauseRead = false
    var pauseWrite = false
    private var readGate: CheckedContinuation<Void, Never>?
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var writeGate: CheckedContinuation<Void, Never>?
    private var writeWaiter: CheckedContinuation<Void, Never>?
    func read(_ key: String) async -> JSONValue? {
        reads.append(key)
        if pauseRead {
            pauseRead = false
            await withCheckedContinuation {
                readGate = $0
                readWaiter?.resume()
                readWaiter = nil
            }
        }
        return .object([:])
    }
    func write(_ key: String, _ value: JSONValue) async {
        writes.append((key, value))
        if pauseWrite {
            pauseWrite = false
            await withCheckedContinuation {
                writeGate = $0
                writeWaiter?.resume()
                writeWaiter = nil
            }
        }
    }
    func waitForRead() async {
        if readGate == nil { await withCheckedContinuation { readWaiter = $0 } }
    }
    func releaseRead() {
        readGate?.resume()
        readGate = nil
    }
    func waitForWrite() async {
        if writeGate == nil { await withCheckedContinuation { writeWaiter = $0 } }
    }
    func releaseWrite() {
        writeGate?.resume()
        writeGate = nil
    }
}

private actor HomeFixtureService: StatisticsService {
    var requestedOffsets: [Int] = []
    var monthlyCalls = 0
    var plannedLimits: [Int] = []
    var lastExpected: JSONValue?
    private var monthlyFails = false
    private var exclusionsFail = false
    private var widgetSaveFails = false
    private var exclusionIds = [9]
    private var pauseMonthly = false
    private var monthlyContinuation: CheckedContinuation<Void, Never>?
    private var monthlyWaiters: [CheckedContinuation<Void, Never>] = []
    func pauseFirstMonthly() { pauseMonthly = true }
    func waitForPausedMonthly() async {
        if monthlyContinuation != nil { return }
        await withCheckedContinuation { monthlyWaiters.append($0) }
    }
    func releaseMonthly() {
        monthlyContinuation?.resume()
        monthlyContinuation = nil
    }
    func chooseExclusions(_ ids: [Int]) { exclusionIds = ids }
    private var widgets: JSONValue = .object(["statistics": .object(["rhythm": .bool(false)])])
    func failMonthly() { monthlyFails = true }
    func failExclusions() { exclusionsFail = true }
    func failWidgetSave() { widgetSaveFails = true }
    func homeMonthly(currency: String, exclusions: InsightExclusions) async throws
        -> InsightMonthlySummary
    {
        monthlyCalls += 1
        if pauseMonthly {
            pauseMonthly = false
            await withCheckedContinuation { continuation in
                monthlyContinuation = continuation
                for waiter in monthlyWaiters { waiter.resume() }
                monthlyWaiters = []
            }
        }
        if monthlyFails { throw APIError.network("synthetic refresh failure") }
        let json =
            exclusions.categoryIds.contains(8)
            ? insightMonthsJSON.replacingOccurrences(of: "1000.99", with: "2000") : insightMonthsJSON
        return try insightFixture(InsightMonthlySummary.self, json)
    }
    func homePace(currency: String) async throws -> HomeSpendingPace {
        try insightFixture(HomeSpendingPace.self, insightPaceJSON)
    }
    func homeBalances(currency: String) async throws -> HomeBankBalances {
        try insightFixture(
            HomeBankBalances.self,
            #"{"accounts":[],"total_net_position":0,"history":{},"total_history":[]}"#)
    }
    func homeNetWorth(currency: String) async throws -> HomeNetWorth {
        try insightFixture(
            HomeNetWorth.self,
            #"{"current":{"liquid":1,"liabilities":-2,"investments":3,"netWorth":2},"monthlyChange":1,"monthlyChangePercent":5,"snapshots":[]}"#
        )
    }
    func homeForecast(
        currency: String, exclusions: InsightExclusions, options: InsightForecastOptions
    ) async throws -> InsightForecast {
        try insightFixture(InsightForecast.self, insightForecastJSON)
    }
    func homeForecastAccuracy() async throws -> InsightForecastAccuracy {
        try insightFixture(InsightForecastAccuracy.self, #"{"methods":[]}"#)
    }
    func homeTransactionCount() async throws -> Int { 60 }
    func homeNeedsCategory() async throws -> Int { 2 }
    func homeTransactions(offset: Int, limit: Int) async throws -> HomeTransactionPage {
        requestedOffsets.append(offset)
        let last = min(60, offset + limit)
        let rows =
            offset < last
            ? ((offset + 1)...last).map { id in
                OpenAPI.Transaction(
                    id: id, transactionDate: "2026-10-01", amount: -1,
                    categoryId: id <= 50 ? 9 : 1, categoryName: "FOOD:Groceries", links: [])
            } : []
        return HomeTransactionPage(items: rows, total: 60)
    }
    func homeAccounts() async throws -> [OpenAPI.Account] { [] }
    func homePlanned(start: String, end: String, limit: Int) async throws -> [OpenAPI
        .PlannedTransaction]
    {
        plannedLimits.append(limit)
        return []
    }
    func homeMatchCount() async throws -> Int { 0 }
    func homeExclusions(scope: String) async throws -> InsightExclusions {
        if exclusionsFail { throw APIError.network("synthetic settings failure") }
        return InsightExclusions(categoryIds: exclusionIds)
    }
    func homeWidgetSetting() async throws -> OpenAPI.Setting {
        OpenAPI.Setting(
            key: "widget_visibility", value: widgets, expected: .object(["exists": .bool(true), "value": widgets]))
    }
    func saveHomeWidgets(_ value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        lastExpected = expected
        if widgetSaveFails { throw APIError.network("synthetic save failure") }
        widgets = value
        return try await homeWidgetSetting()
    }
    func statisticsMonthly(_ query: StatisticsQuery) async throws -> InsightMonthlySummary {
        try await homeMonthly(currency: query.currency, exclusions: query.exclusions)
    }
    func statisticsCategories(_ query: StatisticsQuery) async throws -> StatisticsCategoryPivot {
        try insightFixture(StatisticsCategoryPivot.self, statisticsPivotJSON)
    }
    func statisticsRecipients(_ query: StatisticsQuery) async throws -> StatisticsRecipientInsights {
        try insightFixture(StatisticsRecipientInsights.self, #"{"topMerchants":[],"monthOverMonth":[]}"#)
    }
    func statisticsRecipientYears(_ query: StatisticsQuery) async throws -> StatisticsRecipientYears {
        try insightFixture(StatisticsRecipientYears.self, #"{"recipientsByYear":{}}"#)
    }
    func statisticsFlow(currency: String, year: Int, exclusions: InsightExclusions) async throws -> StatisticsFlow {
        try insightFixture(StatisticsFlow.self, statisticsFlowJSON)
    }
}

private let statisticsPivotJSON =
    #"{"categoryPivot":{"2026-09":[{"categoryId":3,"categoryName":"legacy:ambiguous:label","categoryPathIds":[1,2,3],"categoryPathSegments":["Food:literal","Groceries","Fruit"],"total":200,"income":500,"expense":-300,"transactionCount":4,"incomeByOwner":{"joint":100}},{"categoryId":4,"categoryName":"FOOD:Vegetables","categoryPathIds":[1,2,4],"categoryPathSegments":["Food:literal","Groceries","Vegetables"],"total":-100,"income":0,"expense":-100,"transactionCount":1}],"2025-12":[{"categoryId":3,"categoryName":"legacy:ambiguous:label","categoryPathIds":[1,2,3],"categoryPathSegments":["Food:literal","Groceries","Fruit"],"total":-50,"transactionCount":1}]}}"#
private let statisticsFlowJSON =
    #"{"nodes":[{"id":"income","label":"Income","value":100},{"id":"spending","label":"Spending","value":100},{"id":"food","label":"Food","value":60},{"id":"home","label":"Home","value":40}],"links":[{"source":"income","target":"spending","value":100},{"source":"spending","target":"food","value":60},{"source":"spending","target":"home","value":40}],"year":2026}"#

private func statisticsSnapshotFixture() throws -> StatisticsSnapshot {
    StatisticsSnapshot(
        monthly: try insightFixture(InsightMonthlySummary.self, insightMonthsJSON),
        pivot: try insightFixture(StatisticsCategoryPivot.self, statisticsPivotJSON),
        recipients: try insightFixture(StatisticsRecipientInsights.self, #"{"topMerchants":[],"monthOverMonth":[]}"#),
        recipientYears: try insightFixture(StatisticsRecipientYears.self, #"{"recipientsByYear":{}}"#))
}

@Suite("Insights aggregation and custom-chart parity")
struct StatisticsDataTests {
    @Test func rollingWindowUsesLocalMonthBoundariesAcrossLeapYears() throws {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "Europe/Brussels")!
        let date = calendar.date(from: DateComponents(year: 2024, month: 2, day: 29, hour: 18))!
        let query = StatisticsWindow.rolling24.queryItems(now: date, calendar: calendar)
        #expect(query.first { $0.name == "start_date" }?.value == "2022-03-01")
        #expect(query.first { $0.name == "end_date" }?.value == "2024-02-29")
        #expect(StatisticsWindow.all.queryItems(now: date, calendar: calendar).isEmpty)
        #expect(
            StatisticsWindow.all.queryItems(now: date, calendar: calendar, includeAllTime: true).first?.value == "true")
    }
    @Test func mixedSignCategoriesKeepExplicitExpenseAndIncomeInsteadOfSignOfNet() throws {
        let snapshot = try statisticsSnapshotFixture()
        let periods: Set<String> = ["2026-09"]
        #expect(snapshot.categories(metric: .expense, periods: periods).reduce(0) { $0 + $1.total } == 400)
        #expect(snapshot.categories(metric: .income, periods: periods).reduce(0) { $0 + $1.total } == 500)
        #expect(snapshot.categories(metric: .absolute, periods: periods).reduce(0) { $0 + $1.total } == 300)
        #expect(snapshot.categories(metric: .net, periods: periods).reduce(0) { $0 + $1.total } == 100)
    }
    @Test func hierarchicalPivotTotalsCountEachSourceOnceAndPreserveAncestorDrills() throws {
        let groups = try statisticsSnapshotFixture().categoryGroups(metric: .expense, periods: ["2026-09"])
        let group = try #require(groups.first)
        #expect(groups.count == 1)
        #expect(group.name == "Food:literal")
        #expect(group.total == 400)
        #expect(group.categoryIds == [3, 4])
        let ancestor = try #require(group.children.first { $0.path.count == 2 })
        #expect(ancestor.categoryIds == [3, 4])
        #expect(ancestor.total == 400)
        #expect(ancestor.incomeByOwner["2026-09"]?["joint"] == 100)
    }
    @Test func olderCachedCategoryPayloadsUseSignSplitFallback() throws {
        let snapshot = try statisticsSnapshotFixture()
        #expect(snapshot.categories(metric: .expense, periods: ["2025-12"]).first?.total == 50)
        #expect(snapshot.categories(metric: .income, periods: ["2025-12"]).first?.total == 0)
    }
    @Test func yearlyCustomChartBoundsUseTheSamePrefixAsYearBuckets() throws {
        var config = CustomChartDraft()
        config.categoryIds = [3]
        config.timeBucket = "yearly"
        config.dateRangeStart = "2026-06-01"
        config.dateRangeEnd = "2026-12-31"
        let dataset = CustomChartDataset(
            configuration: config, statistics: try statisticsSnapshotFixture(),
            recipients: nil, tags: nil, otherLabel: "Other")
        #expect(dataset.periods == ["2026"])
        #expect(dataset.entities.first?.values["2026"] == 200)
    }
    @Test func savedChartBodiesClearDateBoundsExplicitlyAndPreserveAllSevenVariants() throws {
        var config = CustomChartDraft()
        config.name = "  Synthetic chart  "
        config.categoryIds = [3]
        let json = try JSONValue.parse(APIBody.encode(config))
        #expect(json["name"] == .string("Synthetic chart"))
        #expect(json["dateRangeStart"] == .null && json["dateRangeEnd"] == .null)
        #expect(CustomChartKind.allCases.count == 7)
        #expect(CustomChartKind.stackedArea.chartType == "area")
        #expect(CustomChartKind.stackedArea.variant == "stacked")
        #expect(CustomChartKind.bar.variant == "default")
        #expect(CustomChartKind.groupedBar.variant == "grouped")
    }
    @Test func dynamicAllSourcesRetainTheLongTailAsOther() throws {
        let items = (1...10).map { #"{"recipientId":\#($0),"name":"Synthetic \#($0)","total":\#($0)}"# }.joined(
            separator: ",")
        let recipients = try insightFixture(CustomRecipientPivot.self, "{\"recipientPivot\":{\"2026-09\":[\(items)]}}")
        var config = CustomChartDraft()
        config.allRecipients = true
        let dataset = CustomChartDataset(
            configuration: config, statistics: try statisticsSnapshotFixture(),
            recipients: recipients, tags: nil, otherLabel: "Other")
        #expect(dataset.entities.count == 9)
        #expect(dataset.entities.last?.id == "other")
        #expect(dataset.entities.last?.total == 3)
        #expect(dataset.entities.reduce(0) { $0 + $1.total } == 55)
    }
    @Test func sankeyCoordinatesStayBoundedAndNodesDoNotOverlap() throws {
        let flow = try insightFixture(StatisticsFlow.self, statisticsFlowJSON)
        let layout = StatisticsFlowLayout(flow: flow)
        #expect(layout.columnCount == 3)
        #expect(layout.nodes.allSatisfy { $0.x >= 0 && $0.x <= 1 && $0.y >= 0 && $0.y + $0.height <= 1.000001 })
        let last = layout.nodes.filter { $0.column == 2 }.sorted { $0.y < $1.y }
        #expect(last.count == 2)
        #expect(last[0].y + last[0].height <= last[1].y)
        #expect(layout.links.map(\.value) == [100, 60, 40])
    }
    @Test func yearlyTotalsAndRhythmKeepCurrentMonthOutOfExtremes() throws {
        let snapshot = try statisticsSnapshotFixture()
        #expect(snapshot.years.first?.income == Decimal(string: "1000.99"))
        #expect(snapshot.years.first?.spending == Decimal(string: "250.12"))
        let extremes = try #require(snapshot.extremes(currentPeriod: "2026-10"))
        #expect(extremes.best.id == "2026-09" && extremes.worst.id == "2026-09")
        #expect(extremes.positive == 2 && extremes.count == 2)
    }
}

@MainActor
@Suite("Insights query behavior")
struct StatisticsModelTests {
    @Test func invalidationDuringAnOlderWindowRequestCannotReplaceTheNewSnapshot() async {
        let service = HomeFixtureService()
        await service.pauseFirstMonthly()
        let model = StatisticsModel(service: service, now: { PlannedFixture.today })
        let old = Task { await model.appear(settings: .defaults, route: NativeRoute("/statistics")!) }
        await service.waitForPausedMonthly()
        model.invalidate()
        await service.chooseExclusions([8])
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!, force: true)
        #expect(model.filtered?.totalIncome == 2000)
        await service.releaseMonthly()
        await old.value
        #expect(model.filtered?.totalIncome == 2000)
    }
    @Test func changingExclusionsDoesNotRetainMoneyFromThePreviousScope() async {
        let service = HomeFixtureService()
        let model = StatisticsModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!)
        await service.chooseExclusions([8])
        await service.failMonthly()
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!, force: true)
        #expect(model.filtered == nil)
        #expect(model.error != nil)
    }
    @Test func tabChangesReuseTheSameAggregationSnapshot() async {
        let service = HomeFixtureService()
        let model = StatisticsModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!)
        let calls = await service.monthlyCalls
        await model.appear(settings: .defaults, route: NativeRoute("/statistics?tab=categories")!)
        #expect(model.tab == .categories)
        #expect(await service.monthlyCalls == calls)
        #expect(model.data(for: "monthly") == model.filtered)
        model.graphExclusions["monthly"] = false
        #expect(model.data(for: "monthly") == model.unfiltered)
    }
    @Test func failedRefreshKeepsPriorFilteredTotalsAndReportsTheFailure() async {
        let service = HomeFixtureService()
        let model = StatisticsModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!)
        let previous = model.filtered
        await service.failMonthly()
        await model.appear(settings: .defaults, route: NativeRoute("/statistics")!, force: true)
        #expect(model.filtered == previous)
        #expect(model.error != nil)
        #expect(!model.isFetching)
    }
    @Test func metricDrillsIncludeUncategorisedAndSelectedMonthBoundaries() async {
        let service = HomeFixtureService()
        let model = StatisticsModel(service: service, now: { PlannedFixture.today })
        await model.appear(settings: .defaults, route: NativeRoute("/statistics?window=all")!)
        model.categoryMetric = .income
        let route = model.pivotDrill(
            categoryIds: [], period: "2026-09", label: "Synthetic uncategorised", uncategorised: true)
        #expect(route.value("uncategorised") == "true")
        #expect(route.value("transaction_type") == "income")
        #expect(route.value("end_date") == "2026-09-30")
        model.pivotYear = 2026
        #expect(!model.pivotHasPrevious)
        #expect(model.pivotGroups.first?.total == 500)
    }
}

@Suite("Home API adapter contracts")
struct HomeAPIAdapterTests {
    @Test func widgetReadsPreserveAbsentBaselineAndWritesUseTheServerExpectation() async throws {
        let transport = InsightTransport(
            body: #"{"ok":true,"data":{"key":"widget_visibility","value":{},"expected":{"exists":false}}}"#)
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let setting = try await client.homeWidgetSetting()
        #expect(setting.expected == .object(["exists": .bool(false)]))
        let value: JSONValue = .object(["dashboard": .object(["hero": .bool(false)])])
        _ = try await client.saveHomeWidgets(value, expected: setting.expected)
        let request = try #require(await transport.requests.last)
        let body = try JSONDecoder().decode(JSONValue.self, from: #require(request.body))
        #expect(body["expected"] == setting.expected)
        #expect(body["value"] == value)
        #expect(request.method == .put)
    }

    @Test func malformedHiddenCategoryMetadataBlocksExclusions() async throws {
        let transport = ExclusionMetadataTransport()
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        do {
            _ = try await client.homeExclusions(scope: "dashboard")
            Issue.record("Missing category metadata must not produce unfiltered totals")
        } catch let error as APIError {
            guard case .contract = error else {
                Issue.record("Expected category tree contract error")
                return
            }
        }
    }

    @Test func monthlyAdapterKeepsEnvelopePrecisionAndRepeatedExclusions() async throws {
        let transport = InsightTransport(body: "{\"ok\":true,\"data\":\(insightMonthsJSON)}")
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let data = try await client.homeMonthly(
            currency: "USD", exclusions: InsightExclusions(categoryIds: [3, 8], recipientIds: [4]))
        #expect(data.latest?.total_income == Decimal(string: "1000.99"))
        let request = try #require(await transport.requests.first)
        #expect(request.url.path == "/api/aggregations/monthly-summary")
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.filter { $0.name == "excluded_category_ids" }.map(\.value) == ["3", "8"])
        #expect(query.first { $0.name == "currency" }?.value == "USD")
    }

    @Test func plannedAdapterSendsCompleteLocalDateWindow() async throws {
        let transport = InsightTransport(
            body: #"{"ok":true,"data":{"items":[],"total":0,"limit":200,"offset":0,"links":[]}}"#)
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        _ = try await client.homePlanned(start: "2026-10-13", end: "2026-10-31", limit: 200)
        let request = try #require(await transport.requests.first)
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(query.first { $0.name == "start_date" }?.value == "2026-10-13")
        #expect(query.first { $0.name == "end_date" }?.value == "2026-10-31")
        #expect(query.first { $0.name == "active" }?.value == "true")
        #expect(query.first { $0.name == "limit" }?.value == "200")
    }

    @Test func malformedTransactionCountIsAContractErrorInsteadOfZero() async throws {
        let transport = InsightTransport(body: #"{"ok":true,"data":{"wrong_count":12}}"#)
        let client = APIClient(
            baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        do {
            _ = try await client.homeTransactionCount()
            Issue.record("A malformed response must not display a zero transaction count")
        } catch let error as APIError {
            guard case .contract = error else {
                Issue.record("Expected contract error")
                return
            }
        }
    }
}

private actor InsightTransport: APITransport {
    private let body: String
    var requests: [APIRequest] = []
    init(body: String) { self.body = body }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return APIResponse(status: 200, body: Data(body.utf8))
    }
}

private struct ExclusionMetadataTransport: APITransport {
    func send(_ request: APIRequest) async throws -> APIResponse {
        let body: String
        switch request.url.path {
        case "/api/settings/dashboard_settings":
            body = #"{"key":"dashboard_settings","value":{},"expected":{"exists":false}}"#
        case "/api/categories/tree":
            body = #"{"items":[]}"#
        default:
            body = #"{"items":[],"total":0,"limit":1000,"offset":0,"links":[]}"#
        }
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(body)}".utf8))
    }
}
