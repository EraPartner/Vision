import Foundation
import Testing

@testable import VisionNativeCore

private func raceDecode<Value: Decodable>(_ type: Value.Type, _ json: String) throws -> Value {
    try JSONDecoder().decode(type, from: Data(json.utf8))
}
private let racePivotJSON =
    #"{"categoryPivot":{"2026-01":[{"categoryId":7,"categoryName":"Synthetic category","total":-100,"transactionCount":1}],"2026-02":[{"categoryId":7,"categoryName":"Synthetic category","total":20,"transactionCount":1}]}}"#
private func raceSnapshot() throws -> StatisticsSnapshot {
    StatisticsSnapshot(
        monthly: try raceDecode(InsightMonthlySummary.self, #"{"months":[]}"#),
        pivot: try raceDecode(StatisticsCategoryPivot.self, racePivotJSON),
        recipients: try raceDecode(StatisticsRecipientInsights.self, #"{"topMerchants":[],"monthOverMonth":[]}"#),
        recipientYears: try raceDecode(StatisticsRecipientYears.self, #"{"recipientsByYear":{}}"#))
}

enum RaceWidgetScreen: Sendable, CaseIterable { case home, statistics }
enum RaceChartMutation: Sendable, CaseIterable { case save, delete }

@MainActor
@Suite("Insights saved-chart and widget read races")
struct InsightsRaceTests {
    @Test func yearlyCategoryBarsTakeMagnitudeAfterSignedMonthsAreBucketed() throws {
        var draft = CustomChartDraft()
        draft.categoryIds = [7]
        let snapshot = try raceSnapshot()
        let monthly = CustomChartDataset(
            configuration: draft, statistics: snapshot,
            recipients: nil, tags: nil, otherLabel: "Other")
        #expect(monthly.entities.first?.values == ["2026-01": 100, "2026-02": 20])
        draft.timeBucket = .yearly
        let yearly = CustomChartDataset(
            configuration: draft, statistics: snapshot,
            recipients: nil, tags: nil, otherLabel: "Other")
        #expect(yearly.entities.first?.values == ["2026": 80])
    }

    @Test(arguments: RaceWidgetScreen.allCases, [false, true])
    func latePreferenceReadsCannotUndoCompletedEditsOrReplaceTheirBaseline(
        screen: RaceWidgetScreen, readStartsDuringSave: Bool
    ) async {
        let service = RaceHomeService()
        let home = HomeModel(service: service)
        let statistics = StatisticsModel(service: service)
        let id = screen == .home ? "hero" : "monthly"
        let nextId = screen == .home ? "attention" : "netTrend"
        @MainActor func load() async {
            if screen == .home {
                await home.appear(settings: .defaults, route: NativeRoute("/")!, force: true)
            } else {
                await statistics.appear(settings: .defaults, route: NativeRoute("/statistics")!, force: true)
            }
        }
        @MainActor func set(_ id: String) async {
            if screen == .home {
                await home.setWidget(id, visible: false)
            } else {
                await statistics.setWidget(id, visible: false)
            }
        }
        await load()
        #expect(screen == .home ? home.widgetsLoaded : statistics.widgetsLoaded)
        await service.pauseNextWidgetRead()
        if readStartsDuringSave {
            await service.pauseNextWidgetSave()
            let save = Task { await set(id) }
            await service.waitForWidgetSave()
            let read = Task { await load() }
            await service.waitForWidgetRead()
            await service.releaseWidgetSave()
            await save.value
            await service.releaseWidgetRead()
            await read.value
        } else {
            let read = Task { await load() }
            await service.waitForWidgetRead()
            await set(id)
            await service.releaseWidgetRead()
            await read.value
        }
        #expect(screen == .home ? !home.isVisible(id) : !statistics.isVisible(id))
        await set(nextId)
        let writes = await service.writes
        #expect(writes.count == 2)
        #expect(writes[1].expected == .object(["exists": .bool(true), "value": writes[0].value]))
    }

    @Test(arguments: RaceChartMutation.allCases)
    func oldChartListReturningAfterAMutationCannotRestoreDeletedChartsOrOldConfiguration(
        mutation: RaceChartMutation
    ) async throws {
        let service = RaceSavedChartsService()
        let model = SavedChartsModel(service: service)
        let snapshot = try raceSnapshot()
        let strings = DictionaryStrings(language: .en, table: ["customChart.other": "Other"])
        await model.appear(snapshot: snapshot, currency: "EUR", strings: strings)
        let chart = try #require(model.charts.first)
        await service.pauseNextRead()
        let stale = Task { await model.appear(snapshot: snapshot, currency: "EUR", strings: strings) }
        await service.waitForRead()
        if mutation == .delete {
            model.pendingDelete = chart
            await model.confirmDelete()
        } else {
            model.begin(chart: chart)
            model.draft?.name = "Updated synthetic chart"
            model.draft?.kind = .bar
            model.draft?.dateRangeStart = "2026-02-01"
            await model.save()
        }
        #expect(await service.readCount == 3)  // Initial read, delayed old read, authoritative mutation read.
        await service.releaseRead()
        await stale.value
        if mutation == .delete {
            #expect(model.charts.isEmpty)
            #expect(model.datasets[chart.id] == nil)
        } else {
            #expect(model.charts.first?.name == "Updated synthetic chart")
            #expect(model.charts.first?.chartType == .bar)
            #expect(model.datasets[chart.id]?.periods == ["2026-02"])
        }
        #expect(!model.isSaving)
        #expect(!model.isLoading)
    }

    @Test(arguments: RaceChartMutation.allCases)
    func appearanceDuringPendingMutationWaitsForItsAuthoritativeListRead(mutation: RaceChartMutation) async throws {
        let service = RaceSavedChartsService()
        let model = SavedChartsModel(service: service)
        let snapshot = try raceSnapshot()
        let strings = DictionaryStrings(language: .en, table: [:])
        await model.appear(snapshot: snapshot, currency: "EUR", strings: strings)
        let chart = try #require(model.charts.first)
        await service.pauseNextMutation()
        if mutation == .delete {
            model.pendingDelete = chart
        } else {
            model.begin(chart: chart)
            model.draft?.name = "Updated synthetic chart"
        }
        let write = Task {
            if mutation == .delete { await model.confirmDelete() } else { await model.save() }
        }
        await service.waitForMutation()
        #expect(model.isSaving)
        await model.appear(snapshot: snapshot, currency: "EUR", strings: strings)
        #expect(await service.readCount == 1)
        await service.releaseMutation()
        await write.value
        #expect(await service.readCount == 2)
        #expect(!model.isSaving)
        #expect(mutation == .delete ? model.charts.isEmpty : model.charts.first?.name == "Updated synthetic chart")
    }

    @Test func savedChartMutationsPublishTheWebToasts() async throws {
        let service = RaceSavedChartsService()
        let model = SavedChartsModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        let strings = DictionaryStrings(language: .en, table: [:])
        await model.appear(snapshot: try raceSnapshot(), currency: "EUR", strings: strings)
        let original = try #require(model.charts.first)

        model.begin()
        model.draft?.name = "Created synthetic chart"
        model.draft?.allCategories = true
        await model.save()
        #expect(model.notice?.key == "charts.saved")
        #expect(model.notice?.kind == .success)
        #expect(center.entries.map(\.notice.key) == ["charts.saved"])

        model.begin(chart: original)
        model.draft?.name = "Updated synthetic chart"
        await model.save()
        #expect(center.entries.count == 1)  // The web update succeeds without a toast.

        model.pendingDelete = original
        await model.confirmDelete()
        #expect(model.notice?.key == "charts.deleted")

        await service.failNextMutations()
        let remaining = try #require(model.charts.first)
        model.begin()
        model.draft?.name = "Failed synthetic chart"
        model.draft?.allCategories = true
        await model.save()
        #expect(model.notice?.key == "charts.saveFailed")
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.detail?.isEmpty == false)
        model.close()
        model.begin(chart: remaining)
        model.draft?.name = "Failed update"
        await model.save()
        #expect(model.notice?.key == "charts.updateFailed")
        model.close()
        model.pendingDelete = remaining
        await model.confirmDelete()
        #expect(model.notice?.key == "charts.deleteFailed")
        #expect(
            Array(center.entries.map(\.notice.key).suffix(3))
                == ["charts.saveFailed", "charts.updateFailed", "charts.deleteFailed"])
        let last = try #require(model.notice)
        model.clearNotice(last.id)
        #expect(model.notice == nil)
    }
}

/// Gates capture the response before suspending; releasing a request after a write
/// reproduces a backend GET that began with an older database snapshot.
private actor InsightsResponseGate<Value: Sendable> {
    private var continuation: CheckedContinuation<Value, Never>?
    private var value: Value?
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func suspend(_ value: Value) async -> Value {
        self.value = value
        return await withCheckedContinuation {
            continuation = $0
            for waiter in waiters { waiter.resume() }
            waiters = []
        }
    }
    func wait() async {
        if continuation != nil { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func release() {
        if let value { continuation?.resume(returning: value) }
        continuation = nil
        value = nil
    }
}

private actor RaceHomeService: StatisticsService {
    struct Write: Sendable {
        let value: JSONValue
        let expected: JSONValue
    }
    private var widgets: JSONValue = .object([:])
    private var pauseRead = false
    private var pauseSave = false
    private let readGate = InsightsResponseGate<OpenAPI.Setting>()
    private let saveGate = InsightsResponseGate<Bool>()
    private(set) var writes: [Write] = []
    func pauseNextWidgetRead() { pauseRead = true }
    func pauseNextWidgetSave() { pauseSave = true }
    func waitForWidgetRead() async { await readGate.wait() }
    func waitForWidgetSave() async { await saveGate.wait() }
    func releaseWidgetRead() async { await readGate.release() }
    func releaseWidgetSave() async { await saveGate.release() }
    private func widgetRecord() -> OpenAPI.Setting {
        OpenAPI.Setting(
            key: "widget_visibility", value: widgets,
            expected: .object(["exists": .bool(true), "value": widgets]))
    }
    func homeWidgetSetting() async throws -> OpenAPI.Setting {
        let record = widgetRecord()
        if pauseRead {
            pauseRead = false
            return await readGate.suspend(record)
        }
        return record
    }
    func saveHomeWidgets(_ value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        writes.append(Write(value: value, expected: expected))
        if pauseSave {
            pauseSave = false
            _ = await saveGate.suspend(true)
        }
        widgets = value
        return widgetRecord()
    }
    func homeExclusions(scope: String) async throws -> InsightExclusions { InsightExclusions() }
    func homeMonthly(currency: CurrencyCode, exclusions: InsightExclusions) async throws -> InsightMonthlySummary {
        try raceDecode(InsightMonthlySummary.self, #"{"months":[]}"#)
    }
    func homePace(currency: CurrencyCode) async throws -> HomeSpendingPace { throw APIError.backendUnavailable }
    func homeBalances(currency: CurrencyCode) async throws -> HomeBankBalances { throw APIError.backendUnavailable }
    func homeNetWorth(currency: CurrencyCode) async throws -> HomeNetWorth { throw APIError.backendUnavailable }
    func homeForecast(currency: CurrencyCode, exclusions: InsightExclusions, options: InsightForecastOptions) async throws
        -> InsightForecast
    {
        throw APIError.backendUnavailable
    }
    func homeForecastAccuracy() async throws -> InsightForecastAccuracy { throw APIError.backendUnavailable }
    func homeTransactionCount() async throws -> Int { 0 }
    func homeNeedsCategory() async throws -> Int { 0 }
    func homeTransactions(offset: Int, limit: Int) async throws -> HomeTransactionPage {
        HomeTransactionPage(items: [], total: 0)
    }
    func homeAccounts() async throws -> [OpenAPI.Account] { [] }
    func homePlanned(start: String, end: String, limit: Int) async throws -> [OpenAPI.PlannedTransaction] { [] }
    func homeMatchCount() async throws -> Int { 0 }
    func statisticsMonthly(_ query: StatisticsQuery) async throws -> InsightMonthlySummary {
        try await homeMonthly(currency: query.currency, exclusions: query.exclusions)
    }
    func statisticsCategories(_ query: StatisticsQuery) async throws -> StatisticsCategoryPivot {
        try raceDecode(StatisticsCategoryPivot.self, racePivotJSON)
    }
    func statisticsRecipients(_ query: StatisticsQuery) async throws -> StatisticsRecipientInsights {
        try raceDecode(StatisticsRecipientInsights.self, #"{"topMerchants":[],"monthOverMonth":[]}"#)
    }
    func statisticsRecipientYears(_ query: StatisticsQuery) async throws -> StatisticsRecipientYears {
        try raceDecode(StatisticsRecipientYears.self, #"{"recipientsByYear":{}}"#)
    }
    func statisticsFlow(currency: CurrencyCode, year: Int, exclusions: InsightExclusions) async throws -> StatisticsFlow {
        throw APIError.backendUnavailable
    }
}

private actor RaceSavedChartsService: SavedChartsService {
    private var charts: [OpenAPI.SavedChart] = [raceChart()]
    private var pauseRead = false
    private var pauseMutation = false
    private let readGate = InsightsResponseGate<[OpenAPI.SavedChart]>()
    private let mutationGate = InsightsResponseGate<Bool>()
    private(set) var readCount = 0
    private var failMutations = false
    func failNextMutations() { failMutations = true }
    func pauseNextRead() { pauseRead = true }
    func pauseNextMutation() { pauseMutation = true }
    func waitForRead() async { await readGate.wait() }
    func waitForMutation() async { await mutationGate.wait() }
    func releaseRead() async { await readGate.release() }
    func releaseMutation() async { await mutationGate.release() }
    func savedCharts() async throws -> [OpenAPI.SavedChart] {
        readCount += 1
        let snapshot = charts
        if pauseRead {
            pauseRead = false
            return await readGate.suspend(snapshot)
        }
        return snapshot
    }
    func saveChart(id: SavedChartID?, draft: CustomChartDraft) async throws -> OpenAPI.SavedChart {
        if pauseMutation {
            pauseMutation = false
            _ = await mutationGate.suspend(true)
        }
        if failMutations { throw APIError.invalidRequest("Synthetic chart failure") }
        let saved = raceChart(id: id ?? SavedChartID(rawValue: charts.count + 1), draft: draft)
        charts.removeAll { $0.id == saved.id }
        charts.append(saved)
        return saved
    }
    func deleteSavedChart(id: SavedChartID) async throws {
        if pauseMutation {
            pauseMutation = false
            _ = await mutationGate.suspend(true)
        }
        if failMutations { throw APIError.invalidRequest("Synthetic chart failure") }
        charts.removeAll { $0.id == id }
    }
    func customRecipientPivot(currency: CurrencyCode, draft: CustomChartDraft) async throws -> CustomRecipientPivot {
        try raceDecode(CustomRecipientPivot.self, #"{"recipientPivot":{}}"#)
    }
    func customTagPivot(currency: CurrencyCode, draft: CustomChartDraft) async throws -> CustomTagPivot {
        try raceDecode(CustomTagPivot.self, #"{"tagPivot":{}}"#)
    }
    func customChartRecipients() async throws -> [OpenAPI.Recipient] { [] }
    func customChartTags() async throws -> [OpenAPI.Tag] { [] }
}

private func raceChart(id: SavedChartID = 1, draft: CustomChartDraft? = nil) -> OpenAPI.SavedChart {
    var configuration = draft ?? CustomChartDraft()
    if draft == nil {
        configuration.name = "Original synthetic chart"
        configuration.allCategories = true
    }
    return OpenAPI.SavedChart(
        id: id, name: configuration.name, chartType: configuration.kind.chartType,
        chartVariant: configuration.kind.variant, timeBucket: configuration.timeBucket,
        categoryIds: configuration.categoryIds.map(\.rawValue), recipientIds: configuration.recipientIds, tagIds: configuration.tagIds,
        allCategories: configuration.allCategories, allRecipients: configuration.allRecipients,
        allTags: configuration.allTags,
        dateRangeStart: configuration.dateRangeStart, dateRangeEnd: configuration.dateRangeEnd,
        createdAt: "2026-01-01", updatedAt: "2026-01-01")
}
