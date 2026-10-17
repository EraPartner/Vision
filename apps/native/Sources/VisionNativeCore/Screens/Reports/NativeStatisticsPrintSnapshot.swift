import Foundation

public struct NativeStatisticsPrintLocalState: Equatable, Sendable {
    public var rollingAverage = false
    public var selection: [String: String] = [:]
    public var rangeStart: [String: String] = [:]
    public init() {}
}

public enum NativeStatisticsPrintSection: Hashable, Identifiable, Sendable {
    case header, rhythm, digest, monthly, netTrend, categoryPie, categoryTrend
    case recipients, yearlyComparison, yearlySummary, flow, customHeader, customStatus
    case pivotTable(Int)
    case savedChart(Int)
    public var id: String {
        switch self {
        case .pivotTable(let page): return "pivotTable:\(page)"
        case .savedChart(let id): return "savedChart:\(id)"
        default: return String(describing: self)
        }
    }
}

/// Values belonging to the loaded Statistics query and its current presentation. No requests,
/// custom-chart dataset rebuilds, or changes to the active models occur while capturing them.
public struct NativeStatisticsPrintSnapshot: Sendable {
    public let filtered: StatisticsSnapshot
    public let unfiltered: StatisticsSnapshot?
    public let exclusions: InsightExclusions
    public let window: StatisticsWindow
    public let tab: StatisticsTab
    public let graphExclusions: [String: Bool]
    public let widgets: InsightWidgetVisibility
    public let localState: NativeStatisticsPrintLocalState
    public let currentPeriod: String
    public let recipientQuery: LocalTableQuery
    public let recipientVisibleCount: Int
    public let categoryMetric: StatisticsMetric
    public let categoryYear: Int?
    public let pivotYear: Int?
    public let recipientYear: Int?
    public let collapsedGroups: Set<String>
    public let pivotPeriods: [String]
    public let pivotPage: Int
    public let flowYear: Int
    public let flow: StatisticsFlow?
    public let flowError: String?
    public let digest: StatisticsDigest?
    public let digestError: String?
    public let digestExpanded: Bool
    public let savedCharts: [OpenAPI.SavedChart]
    public let savedDatasets: [Int: CustomChartDataset]
    public let savedErrors: [Int: String]
    public let savedError: String?
    public let savedLocalState: NativeStatisticsPrintLocalState
    public let settings: NativeAppSettings
    public let strings: any Localizing
    public let theme: ThemeSelection
    public let route: NativeRoute

    public func isVisible(_ id: String) -> Bool {
        InsightWidget.statistics.first { $0.id == id }.map { widgets.isVisible($0, page: "statistics") } ?? false
    }
    public var sections: [NativeStatisticsPrintSection] {
        var sections: [NativeStatisticsPrintSection] = [.header]
        switch tab {
        case .overview:
            if isVisible("summaryCards") { sections.append(.rhythm) }
            if digest != nil || digestError != nil { sections.append(.digest) }
            if isVisible("monthly") { sections.append(.monthly) }
            if isVisible("netTrend") { sections.append(.netTrend) }
        case .categories:
            if isVisible("categoryPie") { sections.append(.categoryPie) }
            if isVisible("categoryTrend") { sections.append(.categoryTrend) }
            if isVisible("pivotTable") {
                sections += (0..<max(1, (pivotPeriods.count + 3) / 4)).map { .pivotTable($0) }
            }
        case .recipients:
            if isVisible("topRecipients") { sections.append(.recipients) }
        case .yearly:
            if isVisible("yearlyComparison") { sections.append(.yearlyComparison) }
            if isVisible("yearlySummary") { sections.append(.yearlySummary) }
        case .flow: sections.append(.flow)
        case .custom:
            sections.append(.customHeader)
            sections += savedCharts.map { .savedChart($0.id) }
            if savedError != nil { sections.append(.customStatus) }
        }
        return sections
    }

    @MainActor public init(
        screens: StatisticsScreens, settings: NativeAppSettings, strings: any Localizing,
        theme: ThemeSelection, route: NativeRoute
    ) throws {
        let model = screens.model
        guard route.path == "/statistics", model.matchesPrintRoute(route, currency: settings.defaultCurrency),
            model.hasData, let filtered = model.filtered,
            model.tab != .flow
                || (!model.isFlowLoading
                    && (model.flow.map { $0.year == model.flowYear } ?? (model.flowError != nil))),
            model.tab != .custom || screens.saved.matchesPrintSnapshot(filtered, currency: settings.defaultCurrency)
        else { throw APIError.invalidRequest("Statistics print requires the currently loaded page") }
        self.filtered = filtered
        unfiltered = model.unfiltered
        exclusions = model.exclusions
        window = model.window
        tab = model.tab
        graphExclusions = model.graphExclusions
        widgets = model.widgets
        localState = model.printLocalState
        currentPeriod = model.currentPeriod
        recipientQuery = model.recipientQuery
        recipientVisibleCount = model.recipientVisibleCount
        categoryMetric = model.categoryMetric
        categoryYear = model.categoryYear
        pivotYear = model.pivotYear
        recipientYear = model.recipientYear
        collapsedGroups = model.collapsedGroups
        pivotPeriods = model.pivotPeriods
        pivotPage = model.pivotPage
        flowYear = model.flowYear
        flow = model.flow
        flowError = model.flowError
        digest = screens.digest.data
        digestError = screens.digest.error
        digestExpanded = screens.digest.expanded
        savedCharts = screens.saved.charts
        savedDatasets = screens.saved.datasets
        savedErrors = screens.saved.errors
        savedError = screens.saved.error
        savedLocalState = screens.saved.printLocalState
        self.settings = settings
        self.strings = strings
        self.theme = theme
        self.route = route
    }
    @MainActor public static func capture(shell: NativeShellModel) throws -> NativeStatisticsPrintSnapshot {
        guard let screens = shell.statistics else {
            throw APIError.invalidRequest("Statistics print requires the currently loaded page")
        }
        return try NativeStatisticsPrintSnapshot(
            screens: screens, settings: shell.settings, strings: shell.strings, theme: shell.theme, route: shell.route)
    }
}
