import Foundation
import Observation

/// What the detail column shows for the current route.
public enum NativeShellDetail: Equatable, Sendable {
    /// The web app, already at the route.
    case web
    case native(NativeScreen)
}

/// A native screen's unsaved-changes hook (`useUnsavedChanges`): while it reports unsaved
/// changes, the shell asks before a navigation leaves the current path.
public struct NativeLeaveGuard {
    /// Identifies the registration (the screen's route), so a screen removes only its own.
    public let id: String
    public let hasUnsavedChanges: @MainActor () -> Bool
    /// Leave and discard: drops the unsaved work before the navigation continues.
    public let discard: @MainActor () -> Void

    public init(
        id: String, hasUnsavedChanges: @escaping @MainActor () -> Bool, discard: @escaping @MainActor () -> Void
    ) {
        self.id = id
        self.hasUnsavedChanges = hasUnsavedChanges
        self.discard = discard
    }
}

/// The state behind the native navigation shell (ADR-204 phase 2): the web router's
/// route, the `app_settings` native screens read, the theme and the sidebar.
///
/// The web router stays the source of truth. The page reports every route through
/// `shell:route-changed`; a sidebar click only asks the page to move with the `navigate`
/// menu action, and the route here changes when the page reports it. The page may keep
/// its route (an unsaved-changes prompt) or redirect (`RequireAdmin`).
@MainActor
@Observable
public final class NativeShellModel {
    public private(set) var route: NativeRoute = .home
    public private(set) var settings: NativeAppSettings = .defaults
    /// `false` until `app_settings` has been read once; native screens wait for it.
    public private(set) var settingsLoaded = false
    /// A completed settings read also refreshes dashboard settings after the web dialog's
    /// 500 ms save debounce, even when the app-format fields themselves did not change.
    public private(set) var settingsRevision = 0
    public var strings: any Localizing
    public var theme: ThemeSelection
    public private(set) var isSidebarVisible = true
    public private(set) var hiddenSections: [NavSectionID: Bool]
    /// The page is presenting something over its route (palette, settings, shortcuts), so
    /// the web view shows even where a native screen exists, until the page reports a route
    /// again (it re-reports the same route when the palette or shortcuts overlay closes).
    public private(set) var isPresentingWeb = false
    /// The route a sidebar click or shortcut asked the page for, until the page reports one.
    public private(set) var pendingRoute: NativeRoute?
    public let exchangeRates: ExchangeRatesModel
    /// `/admin`, `/admin/db`, `/admin/db/:table`, `/admin/providers` and `/admin/endpoints`.
    public let admin: AdminScreens
    /// `/planned`.
    public let planned: PlannedPaymentsModel
    /// `/import`.
    public let imports: ImportsModel
    /// `/transactions`.
    public let transactions: TransactionsModel
    /// `/accounts` and `/accounts/:id`.
    public let accounts: AccountsModel
    /// `/categories`.
    public let categories: CategoriesModel
    /// `/recipients`.
    public let recipients: RecipientsModel
    /// `/`, Home; omitted by shell-only test fixtures and older callers.
    public let home: HomeModel?
    public let statistics: StatisticsScreens?
    public let tax: TaxScreens?
    public let portfolio: PortfolioScreens?
    public let portfolioImports: PortfolioImportScreens?
    public let analysis: AnalysisScreens?
    public let analysisMonitors: AnalysisMonitorsModel?
    public let research: ResearchScreens?
    /// The navigation the Leave this page? alert holds while it asks (`blocker.location`).
    public private(set) var leaveConfirmation: NativeRoute?

    @ObservationIgnored private let loadSettings: @Sendable () async throws -> NativeAppSettings
    @ObservationIgnored private let saveHiddenSections: @MainActor ([NavSectionID: Bool]) -> Void
    @ObservationIgnored private let onNavigate: @MainActor (MenuAction) -> Void
    @ObservationIgnored private let onSidebarVisibilityChange: @MainActor (Bool) -> Void
    @ObservationIgnored private var settingsTask: Task<Void, Never>?
    @ObservationIgnored private var delayedSettingsTask: Task<Void, Never>?
    @ObservationIgnored private let settingsReloadDelay: Duration
    @ObservationIgnored private var shortcuts = NativeShortcuts()
    @ObservationIgnored private var leaveGuard: NativeLeaveGuard?

    /// - Parameters:
    ///   - hiddenSections: the stored section choices; `nil` uses the `defaultHidden` flags.
    ///   - onNavigate: sends a menu action to the page (`navigate`, `replace-route`,
    ///     `open-palette`, `open-shortcuts`, `open-settings`).
    ///   - onSidebarVisibilityChange: the sidebar was shown or hidden.
    ///   - settingsReloadDelay: how long after the settings dialog closes `app_settings` is
    ///     read once more; the page saves them 500 ms after a change.
    public init(
        strings: any Localizing,
        theme: ThemeSelection,
        exchangeRates: ExchangeRatesModel,
        admin: AdminScreens,
        planned: PlannedPaymentsModel,
        imports: ImportsModel,
        transactions: TransactionsModel,
        accounts: AccountsModel,
        categories: CategoriesModel,
        recipients: RecipientsModel,
        home: HomeModel? = nil,
        statistics: StatisticsScreens? = nil,
        tax: TaxScreens? = nil,
        portfolio: PortfolioScreens? = nil,
        portfolioImports: PortfolioImportScreens? = nil,
        analysis: AnalysisScreens? = nil,
        analysisMonitors: AnalysisMonitorsModel? = nil,
        research: ResearchScreens? = nil,
        hiddenSections: [NavSectionID: Bool]? = nil,
        loadSettings: @escaping @Sendable () async throws -> NativeAppSettings,
        saveHiddenSections: @escaping @MainActor ([NavSectionID: Bool]) -> Void = { _ in },
        onNavigate: @escaping @MainActor (MenuAction) -> Void,
        onSidebarVisibilityChange: @escaping @MainActor (Bool) -> Void = { _ in },
        settingsReloadDelay: Duration = .milliseconds(600)
    ) {
        self.strings = strings
        self.theme = theme
        self.exchangeRates = exchangeRates
        self.admin = admin
        self.planned = planned
        self.imports = imports
        self.transactions = transactions
        self.accounts = accounts
        self.categories = categories
        self.recipients = recipients
        self.home = home
        self.statistics = statistics
        self.tax = tax
        self.portfolio = portfolio
        self.portfolioImports = portfolioImports
        self.analysis = analysis
        self.analysisMonitors = analysisMonitors
        self.research = research
        self.hiddenSections = hiddenSections ?? Self.defaultHiddenSections
        self.loadSettings = loadSettings
        self.saveHiddenSections = saveHiddenSections
        self.onNavigate = onNavigate
        self.onSidebarVisibilityChange = onSidebarVisibilityChange
        self.settingsReloadDelay = settingsReloadDelay
        transactions.attach(self)
        accounts.attach(self)
        categories.attach(self)
        recipients.attach(self)
    }

    /// `DEFAULT_HIDDEN` of useSidebarPreferences.
    public static var defaultHiddenSections: [NavSectionID: Bool] {
        var hidden: [NavSectionID: Bool] = [:]
        for section in NavigationRegistry.sections where section.defaultHidden { hidden[section.id] = true }
        return hidden
    }

    // MARK: Route

    /// The native screen for the route, or the web app. A native screen is shown once
    /// `app_settings` has been read (its formats and default currency); an admin screen only
    /// while it says admin mode is on, otherwise the page shows the route and its
    /// `RequireAdmin` redirects, which the page then reports.
    public var detail: NativeShellDetail {
        guard !isPresentingWeb, settingsLoaded, let screen = NativeScreen.screen(forPath: route.path) else {
            return .web
        }
        if screen.requiresAdmin && !settings.adminMode { return .web }
        if screen == .home && home == nil { return .web }
        if screen == .statistics && (statistics == nil || route.value("export") == "pdf") { return .web }
        if screen == .tax && (tax == nil || route.value("export") == "pdf") { return .web }
        if screen.path == "/portfolio" || screen.path.hasPrefix("/portfolio/") {
            if portfolio == nil || route.value("export") == "pdf" { return .web }
        }
        if screen == .portfolioTax && tax == nil { return .web }
        if screen == .portfolioImport && portfolioImports == nil { return .web }
        if case .portfolioImportReview = screen, portfolioImports == nil { return .web }
        if screen == .analysis && analysis == nil { return .web }
        if screen == .analysisMonitors && analysisMonitors == nil { return .web }
        if [.researchHome, .researchMarkets, .researchMarketLookup, .researchWatchlist, .researchCompare].contains(
            screen),
            research == nil
        {
            return .web
        }
        return .native(screen)
    }

    public var sections: [NavSection] {
        NavigationRegistry.visibleSections(adminMode: settings.adminMode)
    }

    /// The URL of the sidebar row to highlight.
    public var selectedItemURL: String? {
        NavigationRegistry.matchItem(path: route.path)?.url
    }

    /// Settings and global overlays cover the native view while React keeps its page mounted.
    public func isTemporarilyCovered(_ path: String) -> Bool {
        route.path == path && (isPresentingWeb || route.value("settings") != nil)
    }

    /// `shell:route-changed`: the page's router moved, or an overlay closed on the same route.
    public func routeDidChange(_ next: NativeRoute) {
        let pathChanged = next.path != route.path
        if pathChanged {
            if route.path == "/analysis" { analysis?.didDisappear() }
            research?.didDisappear(route: route)
            if route.path == "/research/market" { removeLeaveGuard(id: route.path) }
        }
        let settingsClosed = route.value("settings") != nil && next.value("settings") == nil
        let reportClosed = route.value("export") == "pdf" && next.value("export") != "pdf"
        // A new page, the settings dialog closing (`?settings` removed), or the same route
        // again (the palette or shortcuts overlay closed) ends a web presentation over a
        // native screen.
        if pathChanged || settingsClosed || reportClosed || next == route { isPresentingWeb = false }
        pendingRoute = nil
        route = next
        if pathChanged { leaveConfirmation = nil }
        admin.database.routeDidChange(path: next.path)
        // ⌘N's pending Add sheet belongs to the arrival at `/transactions`; landing elsewhere
        // (a redirect, the page's own prompt) drops it.
        if next.path != TransactionsRoutes.path { transactions.cancelAddOnArrival() }
        if let section = NavigationRegistry.matchSection(path: next.path), hiddenSections[section] == true {
            // Landing inside a hidden section shows it for good, like the web sidebar.
            setSection(section, expanded: true)
        }
        // The page may have changed `app_settings` (admin mode, formats) in its settings
        // dialog or on the previous page.
        if pathChanged || settingsClosed { reloadSettings() }
        // The page saves `app_settings` 500 ms after a change, so a read right after the
        // dialog closes can still see the old values.
        if settingsClosed { reloadSettingsLater() }
        if settingsClosed { home?.invalidate() }
        if pathChanged && next.path == InsightsRoutes.home { home?.invalidate() }
        if settingsClosed || pathChanged && next.path == InsightsRoutes.statistics { statistics?.model.invalidate() }
        if settingsClosed || pathChanged && next.path == "/tax" { tax?.invalidate() }
        if settingsClosed || pathChanged && next.path == "/portfolio/tax" { tax?.invalidate() }
        if settingsClosed || pathChanged && (next.path == "/portfolio" || next.path.hasPrefix("/portfolio/")) {
            portfolio?.invalidate()
        }
        if settingsClosed || pathChanged && next.path.hasPrefix("/portfolio/import") { portfolioImports?.invalidate() }
        if settingsClosed || pathChanged && next.path == "/analysis" { analysis?.invalidate() }
        if settingsClosed || pathChanged && next.path == "/analysis/monitors" { analysisMonitors?.invalidate() }
    }

    /// A sidebar click, a menu or shortcut navigation, or another native link. The page moves
    /// (or keeps its route behind its own unsaved-changes prompt) and reports the result; until
    /// then the route stays. While a native screen has unsaved changes, a navigation to another
    /// path waits on the Leave this page? alert instead (`useBlocker`).
    public func navigate(to url: String) {
        guard let next = NativeRoute(url) else { return }
        if next.path != route.path, let leaveGuard, leaveGuard.hasUnsavedChanges() {
            leaveConfirmation = next
            return
        }
        send(next)
    }

    /// `navigate(url, { replace: true })` from a native screen (Review import's Commit and
    /// Discard): the page replaces its history entry and reports the new route.
    public func replace(with url: String) {
        guard let next = NativeRoute(url) else { return }
        pendingRoute = next
        onNavigate(.replaceRoute(next.string))
    }
    /// The existing report dialog owns PDF rendering and report serialization.
    public func openStatisticsReport() {
        guard route.path == InsightsRoutes.statistics else { return }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    public func openTaxReport() {
        guard route.path == "/tax" else { return }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    public func openPortfolioReport() {
        switch NativeScreen.screen(forPath: route.path) {
        case .portfolio, .portfolioHoldings: break
        default: return
        }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    private func send(_ next: NativeRoute) {
        pendingRoute = next
        onNavigate(.navigate(next.string))
    }

    /// A CSV opened from Finder or the dock, or dropped on a native screen
    /// (`registerPendingImportFile` and `navigate("/import")` of `ElectronBridge`): the native
    /// import card always gets the file (pre-filled, not started, within the handoff's 30
    /// seconds), so it is not lost when `/import` turns native after `app_settings` is read.
    /// Once the settings are read the shell moves to `/import` itself and returns `true`.
    /// Before that it returns `false`: the web app takes the file too (`app:csv-opened`) and
    /// navigates, in case `/import` stays a web page.
    public func openImportFile(_ file: ImportFile) -> Bool {
        guard NativeScreen.screen(forPath: ImportRoutes.path) != nil else { return false }
        imports.handoff(file)
        guard settingsLoaded else { return false }
        if detail != .native(.importExport) { navigate(to: ImportRoutes.path) }
        return true
    }

    /// ⌘N, the dock menu's New transaction and the `N` shortcut (`/transactions?new=1`): while
    /// `/transactions` is native, the Add transaction sheet opens on the native screen, at once
    /// when it is already shown, otherwise once the shell arrives at `/transactions`. The
    /// navigation leaves out `new=1`: the page behind the native screen would open its own
    /// sheet for it too. Returns `false` when the page handles it.
    public func newTransaction() -> Bool {
        guard settingsLoaded, NativeScreen.screen(forPath: TransactionsRoutes.path) != nil else { return false }
        if detail == .native(.transactions) {
            transactions.requestAdd()
        } else {
            transactions.requestAddOnArrival()
            navigate(to: TransactionsRoutes.path)
        }
        return true
    }

    /// `/owes`.
    public var owes: OwesModel { transactions.owes }

    /// Import cash and trades can become durable after the user has opened another screen.
    public func portfolioImportDidMutate() async { await portfolioDataDidMutate() }

    /// Portfolio/import/research writes retire sibling reads even when their acknowledgement is lost.
    public func portfolioDataDidMutate() async {
        research?.portfolioDataDidChange()
        home?.invalidate()
        statistics?.model.invalidate()
        tax?.invalidate()
        portfolio?.dataDidChange()
        transactions.invalidate()
        accounts.invalidate()
        let currentRoute = route
        let currentSettings = settings
        guard case .native(let screen) = detail else { return }
        switch screen {
        case .home:
            await home?.appear(settings: currentSettings, route: currentRoute, force: true)
        case .statistics:
            await statistics?.model.appear(settings: currentSettings, route: currentRoute, force: true)
            if route == currentRoute { await statistics?.digest.load(force: true) }
        case .transactions:
            await transactions.reload()
        case .accounts:
            await accounts.load(force: true)
            if route == currentRoute { await accounts.loadPortfolio(force: true) }
        case .accountDetail:
            await accounts.load(force: true)
        case .tax:
            _ = await tax?.loadRoute(route: currentRoute, currency: currentSettings.defaultCurrency, force: true)
        default:
            break
        }
    }

    /// A native screen with unsaved work registers its hook while it is shown.
    public func setLeaveGuard(_ hook: NativeLeaveGuard) {
        leaveGuard = hook
    }

    /// Quit asks first while the registered screen reports unsaved changes.
    public var hasGuardedUnsavedChanges: Bool { leaveGuard?.hasUnsavedChanges() ?? false }

    /// The screen went away; a newer registration stays.
    public func removeLeaveGuard(id: String) {
        if leaveGuard?.id == id { leaveGuard = nil }
    }

    /// Stay on page (`blocker.reset`): the navigation is cancelled.
    public func stayOnPage() {
        leaveConfirmation = nil
        transactions.cancelAddOnArrival()
    }

    /// Leave and discard (`blocker.proceed`): the unsaved work is dropped and the navigation
    /// continues.
    public func leavePage() {
        guard let next = leaveConfirmation else { return }
        leaveConfirmation = nil
        leaveGuard?.discard()
        send(next)
    }

    /// `setSearchParams(..., { replace: true })` for the current route; `nil` deletes the
    /// parameter (`useSearchParamState` writing a default value).
    public func replaceQuery(_ name: String, with value: String?) {
        let next = value.map { route.setting(name, to: $0) } ?? route.removing(name)
        route = next
        onNavigate(.replaceRoute(next.string))
    }

    /// `setSearchParams(next, { replace: true })` with a whole new query for the current path
    /// (the sort pair, written together).
    public func replaceQuery(_ query: [URLQueryItem]) {
        let next = NativeRoute(path: route.path, query: query)
        route = next
        onNavigate(.replaceRoute(next.string))
    }

    public func openSettings() {
        willPresent(.openSettings)
        onNavigate(.openSettings)
    }

    /// A menu action is about to reach the page. One that opens a page dialog shows the web
    /// view, since the dialog belongs to the page.
    public func willPresent(_ action: MenuAction) {
        switch action.action {
        case MenuAction.toggleSidebar.action, "navigate", "replace-route", "set-theme", "native-sidebar":
            return
        default:
            if case .native = detail { isPresentingWeb = true }
        }
    }

    /// A key press on a native screen. Returns `false` when the key is not a shortcut.
    public func handleKey(
        _ key: String, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false,
        now: Date = Date()
    ) -> Bool {
        switch shortcuts.handle(
            key: key, command: command, control: control, option: option, shift: shift, path: route.path, now: now)
        {
        case .ignored:
            return false
        case .consumed:
            return true
        case .navigate(let url):
            if url == TransactionsRoutes.newTransactionRoute, newTransaction() { return true }
            navigate(to: url)
            return true
        case .openPalette:
            willPresent(.openPalette)
            onNavigate(.openPalette)
            return true
        case .openShortcuts:
            willPresent(.openShortcuts)
            onNavigate(.openShortcuts)
            return true
        }
    }

    /// View › Toggle Sidebar (`toggle-sidebar`) acts on the native sidebar.
    public func toggleSidebar() {
        setSidebarVisible(!isSidebarVisible)
    }

    public func setSidebarVisible(_ visible: Bool) {
        guard visible != isSidebarVisible else { return }
        isSidebarVisible = visible
        onSidebarVisibilityChange(visible)
    }

    // MARK: Sections

    /// A collapsible section is open unless hidden, and always while it holds the active page.
    public func isSectionExpanded(_ section: NavSection) -> Bool {
        guard section.collapsible else { return true }
        if hiddenSections[section.id] != true { return true }
        return section.items.contains { $0.isActive(path: route.path) }
    }

    public func setSection(_ id: NavSectionID, expanded: Bool) {
        hiddenSections[id] = !expanded
        saveHiddenSections(hiddenSections)
    }

    // MARK: Settings

    /// Applies `app_settings`: formats, admin mode and the colorblind skin.
    public func apply(settings next: NativeAppSettings) {
        if settingsLoaded {
            home?.invalidate()
            statistics?.model.invalidate()
            tax?.invalidate()
            portfolio?.invalidate()
            portfolioImports?.invalidate()
            analysis?.invalidate()
            analysisMonitors?.invalidate()
        }
        settings = next
        settingsLoaded = true
        settingsRevision &+= 1
        theme.colorblindGainLoss = next.colorblindGainLoss
    }

    /// Reads `app_settings` again; the page may have changed them. A newer request
    /// replaces a pending one, and a failure keeps the last known settings.
    public func reloadSettings() {
        settingsTask?.cancel()
        let load = loadSettings
        settingsTask = Task { [weak self] in
            guard let loaded = try? await load(), !Task.isCancelled else { return }
            self?.apply(settings: loaded)
        }
    }

    /// Reads `app_settings` once more after `settingsReloadDelay`, replacing a pending
    /// delayed read.
    private func reloadSettingsLater() {
        delayedSettingsTask?.cancel()
        let delay = settingsReloadDelay
        delayedSettingsTask = Task { [weak self] in
            try? await Task.sleep(for: delay)
            guard !Task.isCancelled else { return }
            self?.reloadSettings()
        }
    }

    /// Waits for the pending settings requests, the delayed one included, for tests.
    public func settingsSettled() async {
        await delayedSettingsTask?.value
        await settingsTask?.value
    }
}
