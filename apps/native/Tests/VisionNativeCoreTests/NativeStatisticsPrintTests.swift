import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Current-page Statistics print snapshot")
@MainActor struct NativeStatisticsPrintTests {
    private let strings = DictionaryStrings(language: .nl, table: ["statsPage.title": "Inzichten"])
    private let settings = NativeAppSettings(defaultCurrency: "CHF", numberFormat: .ch, showDecimalPlaces: 3)
    private func page(_ tab: String = "overview", visibility: JSONValue = .object([:])) async throws
        -> (StatisticsScreens, StatisticsPrintFixtureService, NativeRoute)
    {
        let service = StatisticsPrintFixtureService(visibility: visibility)
        let model = StatisticsModel(service: service, now: { Date(timeIntervalSince1970: 1_791_936_000) })
        let screens = StatisticsScreens(
            model: model, saved: SavedChartsModel(service: service), digest: StatisticsDigestModel(service: service))
        let route = NativeRoute("/statistics?window=all&tab=" + tab)!
        await model.appear(settings: settings, route: route)
        await screens.digest.load()
        return (screens, service, route)
    }
    private func capture(_ screens: StatisticsScreens, _ route: NativeRoute) throws -> NativeStatisticsPrintSnapshot {
        try NativeStatisticsPrintSnapshot(
            screens: screens, settings: settings, strings: strings, theme: .init(appearance: .dark), route: route)
    }
    @Test func capturesViewLocalComparisonAndDecimalsWithoutRequests() async throws {
        let (screens, service, route) = try await page()
        screens.model.printLocalState.rollingAverage = true
        screens.model.printLocalState.selection = [
            "monthly": "2026-09", "rhythm": "2026-08", "categoryPie": "3", "topRecipients": "1", "flowNode": "cat:3",
            "flowLink": "income→cat:3",
        ]
        screens.model.printLocalState.rangeStart = ["monthly": "2026-03"]
        screens.model.graphExclusions = ["monthly": false]
        screens.digest.expanded = true
        let before = await service.readCount
        let snapshot = try capture(screens, route)
        let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
        #expect(await service.readCount == before)
        #expect(snapshot.localState.rollingAverage)
        #expect(snapshot.localState.selection["rhythm"] == "2026-08")
        #expect(snapshot.localState.selection["categoryPie"] == "3")
        #expect(snapshot.localState.selection["flowLink"] == "income→cat:3")
        #expect(presentation.screens.model.printLocalState.rangeStart["monthly"] == "2026-03")
        #expect(presentation.screens.digest.expanded)
        #expect(snapshot.settings == settings)
        #expect(snapshot.strings.t("statsPage.title") == "Inzichten")
        #expect(snapshot.filtered.monthly.months.first?.total_income == Decimal(string: "1000.1234567890123456789"))
        #expect(presentation.screens.model.data(for: "monthly") == snapshot.unfiltered)
        #expect(snapshot.sections == [.header, .rhythm, .digest, .monthly, .netTrend])
        screens.model.printLocalState = .init()
        screens.model.graphExclusions["monthly"] = true
        screens.digest.expanded = false
        #expect(snapshot.localState.rollingAverage)
        #expect(presentation.screens.model.graphExclusions["monthly"] == false)
        #expect(presentation.screens.digest.expanded)
        #expect(presentation.screens.model.currentPeriod == snapshot.currentPeriod)
        #expect(presentation.screens.model !== screens.model)
        #expect(presentation.screens.digest !== screens.digest)
    }
    @Test func printsOnlyCurrentWidgetsAndSelectedPivotWindow() async throws {
        let visibility: JSONValue = .object([
            "statistics": .object(["categoryPie": .bool(false), "categoryTrend": .bool(false)])
        ])
        let (screens, _, route) = try await page("categories", visibility: visibility)
        screens.model.categoryMetric = .net
        screens.model.categoryYear = 2026
        screens.model.pivotYear = 2026
        screens.model.collapsedGroups = ["id:1"]
        let snapshot = try capture(screens, route)
        #expect(snapshot.sections == [.header, .pivotTable(0), .pivotTable(1), .pivotTable(2)])
        #expect(snapshot.pivotPeriods.count == 12)
        let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
        #expect(presentation.screens.model.pivotPeriods == snapshot.pivotPeriods)
        #expect(presentation.screens.model.categoryMetric == .net)
        #expect(presentation.screens.model.collapsedGroups == ["id:1"])
        #expect(presentation.screens.model.categoryYear == 2026)
        #expect(presentation.screens.model.pivotYear == 2026)
    }
    @Test func freezesRecipientsFilterSortAndLoadedRowLimit() async throws {
        let (screens, _, route) = try await page("recipients")
        screens.model.recipientQuery.search = "synthetic"
        screens.model.recipientQuery.setFilter("name", to: "Cafe")
        screens.model.recipientQuery.toggleSort("totalSpend")
        screens.model.recipientVisibleCount = 1
        screens.model.recipientYear = 2026
        let snapshot = try capture(screens, route)
        let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
        #expect(snapshot.sections == [.header, .recipients])
        #expect(presentation.screens.model.recipientRows.map(\.name) == ["Synthetic Cafe"])
        #expect(presentation.screens.model.recipientVisibleCount == 1)
        #expect(presentation.screens.model.recipientYear == 2026)
        screens.model.recipientQuery.clearAll()
        screens.model.recipientVisibleCount = 50
        #expect(presentation.screens.model.recipientQuery == snapshot.recipientQuery)
        #expect(presentation.screens.model.recipientVisibleCount == 1)
    }
    @Test func rejectsUnloadedOrDifferentRouteWindowAndCurrency() async throws {
        let service = StatisticsPrintFixtureService()
        let screens = StatisticsScreens(
            model: StatisticsModel(service: service), saved: SavedChartsModel(service: service),
            digest: StatisticsDigestModel(service: service))
        #expect(throws: APIError.self) { try capture(screens, NativeRoute("/statistics")!) }
        let (loaded, _, route) = try await page()
        #expect(throws: APIError.self) { try capture(loaded, NativeRoute("/statistics?tab=yearly&window=all")!) }
        #expect(throws: APIError.self) { try capture(loaded, NativeRoute("/statistics?tab=overview")!) }
        #expect(throws: APIError.self) { try capture(loaded, NativeRoute("/tax")!) }
        #expect(throws: APIError.self) {
            try NativeStatisticsPrintSnapshot(
                screens: loaded, settings: .defaults, strings: strings, theme: .init(appearance: .light), route: route)
        }
    }
    @Test func failedSameQueryRefreshKeepsTheVisibleCachedPagePrintable() async throws {
        let (screens, service, route) = try await page()
        let before = try capture(screens, route)
        await service.failMonthly()
        await screens.model.appear(settings: settings, route: route, force: true)
        #expect(screens.model.error != nil)
        #expect(screens.model.hasData)
        let reads = await service.readCount
        let after = try capture(screens, route)
        _ = NativeStatisticsPrintPresentation.prepare(after)
        #expect(before.filtered == after.filtered)
        #expect(before.unfiltered == after.unfiltered)
        #expect(await service.readCount == reads)
    }
    @Test func freezesLoadedFlowAndSavedDatasetsWithoutRebuilding() async throws {
        let (screens, service, flowRoute) = try await page("flow")
        let flowSnapshot = try capture(screens, flowRoute)
        let flowPresentation = NativeStatisticsPrintPresentation.prepare(flowSnapshot)
        #expect(flowSnapshot.sections == [.header, .flow])
        #expect(flowPresentation.screens.model.flow == flowSnapshot.flow)
        screens.model.flowYear = 2025
        #expect(throws: APIError.self) { try capture(screens, flowRoute) }
        #expect(flowPresentation.screens.model.flowYear == 2026)
        let customRoute = NativeRoute("/statistics?window=all&tab=custom")!
        await screens.model.appear(settings: settings, route: customRoute)
        #expect(throws: APIError.self) { try capture(screens, customRoute) }
        await screens.saved.appear(
            snapshot: try #require(screens.model.filtered), currency: settings.defaultCurrency, strings: strings)
        screens.saved.printLocalState.selection["7"] = "2026-09"
        screens.saved.printLocalState.rangeStart["7"] = "2026-02"
        let before = await service.readCount
        let customSnapshot = try capture(screens, customRoute)
        _ = NativeStatisticsPrintPresentation.prepare(customSnapshot)
        #expect(await service.readCount == before)
        #expect(customSnapshot.sections == [.header, .customHeader, .savedChart(7)])
        #expect(customSnapshot.savedDatasets[7] == screens.saved.datasets[7])
        screens.saved.printLocalState = .init()
        #expect(customSnapshot.savedLocalState.selection["7"] == "2026-09")
        #expect(customSnapshot.savedLocalState.rangeStart["7"] == "2026-02")
    }
}

private func statisticsPrintDecode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}
private actor StatisticsPrintFixtureService: StatisticsService, StatisticsDigestService, SavedChartsService {
    var readCount = 0
    private var monthlyFails = false
    func failMonthly() { monthlyFails = true }
    let visibility: JSONValue
    init(visibility: JSONValue = .object([:])) { self.visibility = visibility }
    func homeExclusions(scope: String) async throws -> InsightExclusions {
        readCount += 1
        return .init(categoryIds: [9], recipientIds: [4])
    }
    func homeWidgetSetting() async throws -> OpenAPI.Setting {
        readCount += 1
        return .init(
            key: "widget_visibility", value: visibility,
            expected: .object(["exists": .bool(true), "value": visibility]))
    }
    func statisticsMonthly(_ query: StatisticsQuery) async throws -> InsightMonthlySummary {
        readCount += 1
        if monthlyFails { throw APIError.network("Synthetic refresh failure") }
        let amount = query.exclusions.isEmpty ? "2000.9876543210987654321" : "1000.1234567890123456789"
        let months = (1...12).map { month in
            "{\"month\":\(month),\"year\":2026,\"period_start\":\"2026-\(String(format: "%02d", month))-01\",\"period_end\":\"2026-\(String(format: "%02d", month))-28\",\"total_spending\":-250.12,\"total_income\":\(amount),\"net_amount\":750,\"transaction_count\":4}"
        }
        return try statisticsPrintDecode(
            InsightMonthlySummary.self, "{\"months\":[" + months.joined(separator: ",") + "]}")
    }
    func statisticsCategories(_ query: StatisticsQuery) async throws -> StatisticsCategoryPivot {
        readCount += 1
        return try statisticsPrintDecode(
            StatisticsCategoryPivot.self,
            #"{"categoryPivot":{"2026-09":[{"categoryId":3,"categoryName":"FOOD:Fruit","categoryPathIds":[1,3],"categoryPathSegments":["Food","Fruit"],"total":-300,"income":0,"expense":-300,"transactionCount":4}]}}"#
        )
    }
    func statisticsRecipients(_ query: StatisticsQuery) async throws -> StatisticsRecipientInsights {
        readCount += 1
        return try statisticsPrintDecode(
            StatisticsRecipientInsights.self,
            #"{"topMerchants":[{"recipientId":1,"name":"Synthetic Cafe","totalSpend":25.123,"transactionCount":2,"avgAmount":12.5615,"firstSeen":"2026-01-01","lastSeen":"2026-10-01"},{"recipientId":2,"name":"Synthetic Shop","totalSpend":50,"transactionCount":2,"avgAmount":25,"firstSeen":"2026-01-01","lastSeen":"2026-10-01"}],"monthOverMonth":[]}"#
        )
    }
    func statisticsRecipientYears(_ query: StatisticsQuery) async throws -> StatisticsRecipientYears {
        readCount += 1
        return try statisticsPrintDecode(StatisticsRecipientYears.self, #"{"recipientsByYear":{}}"#)
    }
    func statisticsFlow(currency: String, year: Int, exclusions: InsightExclusions) async throws -> StatisticsFlow {
        readCount += 1
        return try statisticsPrintDecode(StatisticsFlow.self, "{\"nodes\":[],\"links\":[],\"year\":\(year)}")
    }
    func statisticsDigest() async throws -> StatisticsDigest {
        readCount += 1
        return try statisticsPrintDecode(
            StatisticsDigest.self, #"{"subscriptionCreep":{"new":[],"priceChanges":[]},"categoryOutliers":[]}"#)
    }
    func savedCharts() async throws -> [OpenAPI.SavedChart] {
        readCount += 1
        return [
            .init(
                id: 7, name: "Synthetic Chart", chartType: "line", chartVariant: "grouped", timeBucket: "monthly",
                categoryIds: [3], recipientIds: [], tagIds: [], allCategories: false, allRecipients: false,
                allTags: false, createdAt: "2026-01-01", updatedAt: "2026-01-01")
        ]
    }
    func customChartRecipients() async throws -> [OpenAPI.Recipient] {
        readCount += 1
        return []
    }
    func customChartTags() async throws -> [OpenAPI.Tag] {
        readCount += 1
        return []
    }
    func customRecipientPivot(currency: String, draft: CustomChartDraft) async throws -> CustomRecipientPivot {
        throw APIError.backendUnavailable
    }
    func customTagPivot(currency: String, draft: CustomChartDraft) async throws -> CustomTagPivot {
        throw APIError.backendUnavailable
    }
    func saveChart(id: Int?, draft: CustomChartDraft) async throws -> OpenAPI.SavedChart {
        throw APIError.backendUnavailable
    }
    func deleteSavedChart(id: Int) async throws { throw APIError.backendUnavailable }
    func dismissStatisticsInsight(_ body: JSONValue) async throws { throw APIError.backendUnavailable }
    func saveHomeWidgets(_ value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        throw APIError.backendUnavailable
    }
    func homeMonthly(currency: String, exclusions: InsightExclusions) async throws -> InsightMonthlySummary {
        throw APIError.backendUnavailable
    }
    func homePace(currency: String) async throws -> HomeSpendingPace { throw APIError.backendUnavailable }
    func homeBalances(currency: String) async throws -> HomeBankBalances { throw APIError.backendUnavailable }
    func homeNetWorth(currency: String) async throws -> HomeNetWorth { throw APIError.backendUnavailable }
    func homeForecast(currency: String, exclusions: InsightExclusions, options: InsightForecastOptions) async throws
        -> InsightForecast
    { throw APIError.backendUnavailable }
    func homeForecastAccuracy() async throws -> InsightForecastAccuracy { throw APIError.backendUnavailable }
    func homeTransactionCount() async throws -> Int { throw APIError.backendUnavailable }
    func homeNeedsCategory() async throws -> Int { throw APIError.backendUnavailable }
    func homeTransactions(offset: Int, limit: Int) async throws -> HomeTransactionPage {
        throw APIError.backendUnavailable
    }
    func homeAccounts() async throws -> [OpenAPI.Account] { throw APIError.backendUnavailable }
    func homePlanned(start: String, end: String, limit: Int) async throws -> [OpenAPI.PlannedTransaction] {
        throw APIError.backendUnavailable
    }
    func homeMatchCount() async throws -> Int { throw APIError.backendUnavailable }
}
