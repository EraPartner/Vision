import Foundation
import Observation

@MainActor
@Observable
public final class StatisticsModel {
    public private(set) var filtered: StatisticsSnapshot?
    public private(set) var unfiltered: StatisticsSnapshot?
    public private(set) var error: String?
    public private(set) var isFetching = false
    public private(set) var exclusions = InsightExclusions()
    public private(set) var window: StatisticsWindow = .rolling24
    public private(set) var tab: StatisticsTab = .overview
    public var printLocalState = NativeStatisticsPrintLocalState()
    public var graphExclusions: [String: Bool] = [:]
    public var recipientQuery = LocalTableQuery()
    public var categoryMetric: StatisticsMetric = .absolute
    public var categoryYear: Int?
    public var pivotYear: Int?
    public var recipientYear: Int?
    public var expandedGroups: Set<String> = []
    public var pivotPage = 0
    public var recipientVisibleCount = 50
    public var flowYear: Int
    public private(set) var flow: StatisticsFlow?
    public private(set) var flowError: String?
    public private(set) var isFlowLoading = false
    public private(set) var widgets = InsightWidgetVisibility(nil)
    public private(set) var widgetsLoaded = false
    public private(set) var widgetSavePending = false
    public private(set) var widgetError: String?

    @ObservationIgnored private let service: any StatisticsService
    @ObservationIgnored private let calendar: Calendar
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var frozenPeriod: String?
    @ObservationIgnored private var currency = "EUR"
    @ObservationIgnored private var day = ""
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var flowRevision = UUID()
    @ObservationIgnored private var flowTask: Task<Void, Never>?
    @ObservationIgnored private var widgetBaseline: JSONValue = .null
    @ObservationIgnored private var widgetRevision = UUID()

    public init(
        service: any StatisticsService, calendar: Calendar = .current,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        self.calendar = calendar
        self.now = now
        self.flowYear = calendar.component(.year, from: now())
    }
    /// Restores only captured values into an isolated, inert presentation model.
    init(printSnapshot value: NativeStatisticsPrintSnapshot) {
        service = APIClient(baseURL: { nil })
        calendar = .current
        now = { Date() }
        filtered = value.filtered
        unfiltered = value.unfiltered
        exclusions = value.exclusions
        window = value.window
        tab = value.tab
        graphExclusions = value.graphExclusions
        widgets = value.widgets
        widgetsLoaded = true
        printLocalState = value.localState
        frozenPeriod = value.currentPeriod
        currency = value.settings.defaultCurrency
        recipientQuery = value.recipientQuery
        recipientVisibleCount = value.recipientVisibleCount
        categoryMetric = value.categoryMetric
        categoryYear = value.categoryYear
        pivotYear = value.pivotYear
        recipientYear = value.recipientYear
        expandedGroups = value.expandedGroups
        pivotPage = value.pivotPage
        flowYear = value.flowYear
        flow = value.flow
        flowError = value.flowError
    }
    func matchesPrintRoute(_ route: NativeRoute, currency: String) -> Bool {
        self.currency == currency
            && window == (route.value("window") == "all" ? .all : .rolling24)
            && tab == (StatisticsTab(rawValue: route.value("tab") ?? "") ?? .overview)
    }
    public var isLoading: Bool { filtered == nil && error == nil }
    public var hasData: Bool { !(filtered?.monthly.months.isEmpty ?? true) }
    public var hasExclusions: Bool { !exclusions.isEmpty }
    public var currentPeriod: String { frozenPeriod ?? String(StatisticsWindow.day(now(), calendar: calendar).prefix(7)) }
    public func data(for graph: String) -> StatisticsSnapshot? {
        graphExclusions[graph] == false ? unfiltered : filtered
    }
    public func isVisible(_ id: String) -> Bool {
        InsightWidget.statistics.first { $0.id == id }.map { widgets.isVisible($0, page: "statistics") } ?? false
    }
    public func appear(settings: NativeAppSettings, route: NativeRoute, force: Bool = false) async {
        let nextWindow: StatisticsWindow = route.value("window") == "all" ? .all : .rolling24
        tab = StatisticsTab(rawValue: route.value("tab") ?? "") ?? .overview
        let nextDay = StatisticsWindow.day(now(), calendar: calendar)
        let changed = currency != settings.defaultCurrency || window != nextWindow || day != nextDay
        if changed {
            task?.cancel()
            revision = UUID()
            task = nil
            filtered = nil
            unfiltered = nil
            error = nil
            fetchedAt = nil
            flow = nil
            flowError = nil
            flowRevision = UUID()
            flowTask?.cancel()
            pivotPage = 0
            recipientVisibleCount = settings.defaultPageSize
        }
        currency = settings.defaultCurrency
        window = nextWindow
        day = nextDay
        if !force, let fetchedAt, now().timeIntervalSince(fetchedAt) < 30 {
            if tab == .flow && flow == nil { await loadFlow() }
            return
        }
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        let task = Task { [weak self] in
            guard let self else { return }
            await self.fetch(token: token)
        }
        self.task = task
        await task.value
        if revision == token { self.task = nil }
    }
    private func fetch(token: UUID) async {
        let widgetToken = widgetRevision
        isFetching = true
        do {
            let resolved = try await service.homeExclusions(scope: "statistics")
            guard token == revision, !Task.isCancelled else { return }
            if resolved != exclusions {
                filtered = nil
                error = nil
            }
            exclusions = resolved
            let query = StatisticsQuery(
                currency: currency, window: window, exclusions: resolved, today: now(), calendar: calendar)
            let service = service
            async let filtered = service.statisticsSnapshot(query)
            async let unfiltered: StatisticsSnapshot? =
                resolved.isEmpty ? nil : try await service.statisticsSnapshot(query.unfiltered)
            async let visibility = service.homeWidgetSetting()
            let filteredValue = try await filtered
            let unfilteredValue = try await unfiltered ?? filteredValue
            guard token == revision, !Task.isCancelled else { return }
            self.filtered = filteredValue
            self.unfiltered = unfilteredValue
            error = nil
            fetchedAt = now()
            do {
                let raw = try await visibility
                guard token == revision, !Task.isCancelled else { return }
                if !widgetSavePending, widgetToken == widgetRevision {
                    widgetBaseline = raw.expected
                    widgets = InsightWidgetVisibility(raw.value)
                    widgetsLoaded = true
                    widgetError = nil
                }
            } catch { if token == revision, widgetToken == widgetRevision { widgetError = error.localizedDescription } }
        } catch {
            guard token == revision, !Task.isCancelled else { return }
            self.error = error.localizedDescription
        }
        guard token == revision else { return }
        isFetching = false
        if tab == .flow { await loadFlow() }
    }
    public func invalidate() {
        fetchedAt = nil
        revision = UUID()
        task?.cancel()
        task = nil
        flow = nil
        flowRevision = UUID()
        flowTask?.cancel()
    }

    public var recipientRows: [StatisticsRecipientInsights.Merchant] {
        recipientQuery.apply(
            filtered?.recipients.topMerchants ?? [], keys: StatisticsRecipientInsights.Merchant.tableKeys
        ) { $0.rawValue($1) }
    }
    public func recipientFilterValues(_ key: String) -> [String] {
        LocalTableQuery.uniqueValues(filtered?.recipients.topMerchants ?? [], key: key) { $0.rawValue($1) }
    }
    public func loadMoreRecipients(pageSize: Int) {
        guard recipientVisibleCount < recipientRows.count else { return }
        recipientVisibleCount = min(recipientVisibleCount + pageSize, recipientRows.count)
    }

    public var pivotAllPeriods: [String] {
        (data(for: "pivotTable")?.periods ?? []).filter { period in
            pivotYear.map { period.hasPrefix(String($0) + "-") } ?? true
        }
    }
    public var pivotHasPrevious: Bool { (pivotPage + 1) * 12 < pivotAllPeriods.count }
    public var pivotPeriods: [String] {
        let periods = pivotAllPeriods
        let end = max(0, periods.count - pivotPage * 12)
        return Array(periods[max(0, end - 12)..<end])
    }
    public var pivotGroups: [StatisticsCategoryGroup] {
        data(for: "pivotTable")?.categoryGroups(metric: categoryMetric, periods: Set(pivotAllPeriods)) ?? []
    }
    public func expandAllGroups() { expandedGroups = Set(pivotGroups.filter(\.isExpandable).map(\.id)) }
    public func collapseAllGroups() { expandedGroups = [] }
    public func toggleGroup(_ id: String) {
        if expandedGroups.contains(id) { expandedGroups.remove(id) } else { expandedGroups.insert(id) }
    }
    public func pivotDrill(categoryIds: [Int], period: String?, label: String, uncategorised: Bool = false)
        -> NativeRoute
    {
        let month = period.flatMap { target in filtered?.monthly.months.first { $0.id == target } }
        return InsightsRoutes.drill(
            month: month, type: categoryMetric.transactionType,
            categoryIds: categoryIds, uncategorised: uncategorised, label: label)
    }
    public func loadFlow() async {
        flowTask?.cancel()
        let token = UUID()
        flowRevision = token
        isFlowLoading = true
        flowError = nil
        flow = nil
        let service = service
        let currency = currency
        let year = flowYear
        let excluded = graphExclusions["sankey"] == false ? InsightExclusions() : exclusions
        let task = Task { [weak self] in
            do {
                let answer = try await service.statisticsFlow(currency: currency, year: year, exclusions: excluded)
                guard let self, self.flowRevision == token, !Task.isCancelled else { return }
                self.flow = answer
                self.flowError = nil
                self.isFlowLoading = false
            } catch {
                guard let self, self.flowRevision == token, !Task.isCancelled else { return }
                self.flowError = error.localizedDescription
                self.isFlowLoading = false
            }
        }
        flowTask = task
        await task.value
    }

    public func setWidget(_ id: String, visible: Bool) async {
        await saveWidgets { $0.set(id, visible: visible, page: "statistics") }
    }
    public func allWidgets(visible: Bool) async {
        await saveWidgets { value in
            for widget in InsightWidget.statistics { value.set(widget.id, visible: visible, page: "statistics") }
        }
    }
    public func resetWidgets() async { await saveWidgets { $0.reset(page: "statistics") } }
    private func saveWidgets(_ change: (inout InsightWidgetVisibility) -> Void) async {
        guard widgetsLoaded, !widgetSavePending else { return }
        let old = widgets
        change(&widgets)
        widgetSavePending = true
        widgetRevision = UUID()
        widgetError = nil
        do {
            let saved = try await service.saveHomeWidgets(widgets.json, expected: widgetBaseline)
            widgetBaseline = saved.expected
            widgets = InsightWidgetVisibility(saved.value)
        } catch {
            widgets = old
            widgetError = error.localizedDescription
        }
        widgetRevision = UUID()
        widgetSavePending = false
    }
}
