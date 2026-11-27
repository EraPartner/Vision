import Foundation
import Observation

@MainActor
@Observable
public final class StatisticsModel {
    public private(set) var filtered: StatisticsSnapshot? { didSet { snapshotRevision &+= 1 } }
    public private(set) var unfiltered: StatisticsSnapshot? { didSet { snapshotRevision &+= 1 } }
    public private(set) var error: String?
    public private(set) var isFetching = false
    public private(set) var exclusions = InsightExclusions()
    public private(set) var window: StatisticsWindow = .all
    public private(set) var tab: StatisticsTab = .overview
    public var printLocalState = NativeStatisticsPrintLocalState()
    public var graphExclusions: [String: Bool] = [:]
    public var recipientQuery = LocalTableQuery()
    public var categoryMetric: StatisticsMetric = .absolute
    public var categoryYear: Int?
    /// Changing the year returns the pivot to its latest period window, as the web `selectYear` does.
    public var pivotYear: Int? { didSet { if pivotYear != oldValue { pivotPage = 0 } } }
    public var recipientYear: Int?
    /// Groups start expanded; the web pivot tracks the groups a viewer collapsed.
    public var collapsedGroups: Set<String> = []
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
    @ObservationIgnored private var currency = LedgerCurrency.eur
    @ObservationIgnored private var day = ""
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var flowRevision = UUID()
    @ObservationIgnored private var flowTask: Task<Void, Never>?
    @ObservationIgnored private var widgetBaseline: JSONValue = .null
    @ObservationIgnored private var widgetRevision = UUID()
    /// After this long off the page the snapshots are let go (Tor, 2026-11-26: ten minutes, as the
    /// web drops unused query data after its gc time), so a long session does not keep every visited
    /// page's payload resident. Coming back shows the loading state and fetches again.
    static let releaseAfter: Duration = .seconds(600)
    @ObservationIgnored var releaseDelay = StatisticsModel.releaseAfter
    @ObservationIgnored private var releaseTask: Task<Void, Never>?
    @ObservationIgnored private var onPage = false
    /// Bumped whenever a snapshot changes, so a pivot built from an older one is never shown.
    @ObservationIgnored private var snapshotRevision = 0
    /// The pivot built on the main actor: the first one of a page and every one of a print model.
    @ObservationIgnored private var pivotCache: StatisticsPivotEntry?
    /// The pivot an off-main build published; observed, so its readers re-render when it lands.
    private var pivotPublished: StatisticsPivotEntry?
    /// The key of the off-main build in flight.
    @ObservationIgnored private var pivotPending: StatisticsPivotKey?
    /// A print model lays its pages out in one pass, so it never waits for an off-main build.
    @ObservationIgnored private var buildsPivotOnMain = false

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
        currency = LedgerCurrency.display(value.settings)
        recipientQuery = value.recipientQuery
        recipientVisibleCount = value.recipientVisibleCount
        categoryMetric = value.categoryMetric
        categoryYear = value.categoryYear
        pivotYear = value.pivotYear
        recipientYear = value.recipientYear
        collapsedGroups = value.collapsedGroups
        pivotPage = value.pivotPage
        flowYear = value.flowYear
        buildsPivotOnMain = true
        flow = value.flow
        flowError = value.flowError
    }
    func matchesPrintRoute(_ route: NativeRoute, currency: CurrencyCode) -> Bool {
        self.currency == currency
            && window == StatisticsWindow(routeValue: route.value("window"))
            && tab == (StatisticsTab(rawValue: route.value("tab") ?? "") ?? .overview)
    }
    public var isLoading: Bool { filtered == nil && error == nil }
    public var hasData: Bool { !(filtered?.monthly.months.isEmpty ?? true) }
    public var hasExclusions: Bool { !exclusions.isEmpty }
    /// The web `ExclusionToggle` gate on Statistics: the scope applies, whether or not anything is excluded.
    public var showsExclusionToggle: Bool { exclusions.applies }
    public var currentPeriod: String {
        frozenPeriod ?? String(StatisticsWindow.day(now(), calendar: calendar).prefix(7))
    }
    public func data(for graph: String) -> StatisticsSnapshot? {
        graphExclusions[graph] == false ? unfiltered : filtered
    }
    public func isVisible(_ id: String) -> Bool {
        InsightWidget.statistics.first { $0.id == id }.map { widgets.isVisible($0, page: "statistics") } ?? false
    }
    /// A tab click: the tab shows at once, before the route change reaches `appear`, which
    /// then reads the same tab back from the URL.
    public func selectTab(_ next: StatisticsTab) {
        tab = next
    }

    public func appear(settings: NativeAppSettings, route: NativeRoute, force: Bool = false) async {
        onPage = true
        releaseTask?.cancel()
        releaseTask = nil
        let nextWindow = StatisticsWindow(routeValue: route.value("window"))
        tab = StatisticsTab(rawValue: route.value("tab") ?? "") ?? .overview
        let nextDay = StatisticsWindow.day(now(), calendar: calendar)
        let changed = currency != LedgerCurrency.display(settings) || window != nextWindow || day != nextDay
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
        currency = LedgerCurrency.display(settings)
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
                    widgetBaseline = raw.expected.json
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
    /// The shell left the Statistics page: the snapshots go after `releaseDelay` unless it comes back.
    public func didLeavePage() {
        onPage = false
        releaseTask?.cancel()
        let delay = releaseDelay
        releaseTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            self?.releaseSnapshots()
        }
    }

    private func releaseSnapshots() {
        releaseTask = nil
        guard !onPage, task == nil, !isFlowLoading, !widgetSavePending, filtered != nil || flow != nil else { return }
        revision = UUID()
        flowRevision = UUID()
        flowTask?.cancel()
        filtered = nil
        unfiltered = nil
        flow = nil
        error = nil
        fetchedAt = nil
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
    public var pivotPageCount: Int { max(1, (pivotAllPeriods.count + 11) / 12) }
    public var pivotHasPrevious: Bool { (pivotPage + 1) * 12 < pivotAllPeriods.count }
    public var pivotPeriods: [String] {
        let periods = pivotAllPeriods
        let end = max(0, periods.count - pivotPage * 12)
        return Array(periods[max(0, end - 12)..<end])
    }
    public var pivotGroups: [StatisticsCategoryGroup] { pivotPresentation.groups }
    public var pivotColumnTotals: [String: Decimal] { pivotPresentation.totals }
    public var pivotGrandTotal: Decimal { pivotPresentation.total }
    private var pivotKey: StatisticsPivotKey {
        StatisticsPivotKey(
            metric: categoryMetric, year: pivotYear, excluded: graphExclusions["pivotTable"] != false,
            revision: snapshotRevision)
    }
    /// The pivot for the current metric, year, exclusion and snapshot. The first build of a
    /// scope (metric, year, exclusion), and every build of a print model, runs here, so the
    /// labels never show another metric's or year's money; a newer snapshot of the same scope
    /// builds off the main actor while the previous one stays on screen, and publishes only if
    /// the inputs have not moved on since.
    private var pivotPresentation: StatisticsPivotPresentation {
        let key = pivotKey
        let published = pivotPublished
        if let published, published.key == key { return published.value }
        if let cached = pivotCache, cached.key == key { return cached.value }
        guard let snapshot = data(for: "pivotTable") else { return .empty }
        let metric = categoryMetric
        let periods = Set(pivotAllPeriods)
        let shown = [published, pivotCache].compactMap { $0 }
            .filter { $0.key.metric == key.metric && $0.key.year == key.year && $0.key.excluded == key.excluded }
            .max { $0.key.revision < $1.key.revision }
        guard let shown, !buildsPivotOnMain else {
            let interval = NativePerformance.begin("Statistics.presentation")
            defer { NativePerformance.end("Statistics.presentation", interval) }
            let value = StatisticsPivotPresentation(snapshot, metric: metric, periods: periods)
            pivotCache = StatisticsPivotEntry(key: key, value: value)
            return value
        }
        if pivotPending != key {
            pivotPending = key
            Task { [weak self] in
                let value = await Task.detached(priority: .userInitiated) {
                    StatisticsPivotPresentation(snapshot, metric: metric, periods: periods)
                }.value
                guard let self, self.pivotPending == key else { return }
                self.pivotPending = nil
                // The version check: a build for inputs that have since changed is dropped.
                guard self.pivotKey == key else { return }
                self.pivotPublished = StatisticsPivotEntry(key: key, value: value)
            }
        }
        return shown.value
    }
    /// Waits for an off-main pivot build in flight, for tests.
    func pivotSettled() async {
        _ = pivotPresentation
        while pivotPending != nil { await Task.yield() }
    }
    public var pivotExpandableGroupIds: [String] { pivotGroups.filter(\.isExpandable).map(\.id) }
    /// `computeMasterToggleState(...).allCollapsed`: false when nothing can expand.
    public var pivotAllCollapsed: Bool {
        let ids = pivotExpandableGroupIds
        return !ids.isEmpty && ids.allSatisfy(collapsedGroups.contains)
    }
    public func isGroupExpanded(_ id: String) -> Bool { !collapsedGroups.contains(id) }
    public func expandAllGroups() { collapsedGroups = [] }
    public func collapseAllGroups() { collapsedGroups = Set(pivotExpandableGroupIds) }
    public func toggleAllGroups() { if pivotAllCollapsed { expandAllGroups() } else { collapseAllGroups() } }
    public func toggleGroup(_ id: String) {
        if collapsedGroups.contains(id) { collapsedGroups.remove(id) } else { collapsedGroups.insert(id) }
    }
    public func pivotDrill(categoryIds: [CategoryID], period: String?, label: String, uncategorised: Bool = false)
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
            widgetBaseline = saved.expected.json
            widgets = InsightWidgetVisibility(saved.value)
        } catch {
            widgets = old
            widgetError = error.localizedDescription
        }
        widgetRevision = UUID()
        widgetSavePending = false
    }
}

/// What the Statistics pivot is built from: the metric, year, exclusion and snapshot revision.
struct StatisticsPivotKey: Equatable, Sendable {
    let metric: StatisticsMetric
    let year: Int?
    let excluded: Bool
    let revision: Int
}

/// The Statistics pivot's category groups and its column and grand totals.
struct StatisticsPivotPresentation: Sendable {
    let groups: [StatisticsCategoryGroup]
    let totals: [String: Decimal]
    let total: Decimal

    static let empty = StatisticsPivotPresentation(groups: [], totals: [:], total: 0)

    private init(groups: [StatisticsCategoryGroup], totals: [String: Decimal], total: Decimal) {
        self.groups = groups
        self.totals = totals
        self.total = total
    }

    /// Pure: safe to run off the main actor.
    init(_ snapshot: StatisticsSnapshot, metric: StatisticsMetric, periods: Set<String>) {
        let groups = snapshot.categoryGroups(metric: metric, periods: periods)
        var totals: [String: Decimal] = [:]
        var total: Decimal = 0
        for group in groups {
            total += group.total
            for (period, value) in group.values { totals[period, default: 0] += value }
        }
        self.init(groups: groups, totals: totals, total: total)
    }
}

struct StatisticsPivotEntry: Sendable {
    let key: StatisticsPivotKey
    let value: StatisticsPivotPresentation
}
