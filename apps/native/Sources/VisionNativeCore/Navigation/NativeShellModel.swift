import Foundation
import Observation

/// What the detail column shows for the current route.
public enum NativeShellDetail: Equatable, Sendable {
    /// The web app, already at the route.
    case web
    case native(NativeScreen)
    case notFound
}

public enum NativeShellOverlayKind: String, Identifiable, Sendable {
    case palette, shortcuts, settings, report, onboarding
    public var id: String { rawValue }
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
/// By default the web router stays the source of truth. The page reports every route through
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
    public var isRendererReady = false
    public var isReloadingGraph = false
    public private(set) var pageZoom: Double = 1
    public func setPageZoom(_ factor: Double) {
        guard factor.isFinite else { return }
        pageZoom = min(PageZoom.maximumFactor, max(PageZoom.minimumFactor, factor))
    }
    /// A completed settings read also refreshes dashboard settings after the web dialog's
    /// 500 ms save debounce, even when the app-format fields themselves did not change.
    public private(set) var settingsRevision = 0
    public var strings: any Localizing { didSet { onboarding?.strings = strings } }
    public var theme: ThemeSelection
    public private(set) var isSidebarVisible = true
    public private(set) var hiddenSections: [NavSectionID: Bool]
    /// The page is presenting something over its route (palette, settings, shortcuts), so
    /// the web view shows even where a native screen exists, until the page reports a route
    /// again (it re-reports the same route when the palette or shortcuts overlay closes).
    public private(set) var isPresentingWeb = false
    public var isPresentingOnboarding = false
    /// The route a sidebar click or shortcut asked the page for, until the page reports one.
    public private(set) var pendingRoute: NativeRoute?
    /// Phase-4 routing preparation only. The SDK does not opt in until the remaining
    /// renderer storage/helper/lifecycle dependencies have independent replacements.
    public private(set) var nativeNavigation: NativeNavigationHistory?
    public var nativeNavigationLocation: NativeNavigationLocation? { nativeNavigation?.location }
    public var canGoBack: Bool { nativeNavigation?.canGoBack ?? false }
    public var canGoForward: Bool { nativeNavigation?.canGoForward ?? false }
    public let exchangeRates: ExchangeRatesModel
    public let notices: NativeNoticeCenter
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
    public let researchForecast: ResearchForecastScreens?
    public let researchChartBuilder: ResearchChartBuilderModel?
    public let researchDossiers: ResearchDossiersModel?
    public let aiChat: AIChatScreens?
    public let nativeSettings: NativeSettingsModel?
    public let settingsAI: NativeSettingsAIModel?
    public let settingsBackup: NativeSettingsBackupModel?
    public let settingsAbout: NativeSettingsAboutModel?
    public let commandPalette: NativeCommandPaletteModel?
    public let shellNotifications: NativeShellNotificationsModel?
    public let onboarding: NativeOnboardingModel?
    public let reports: NativeReportModel?
    public let nativeFallback: Bool
    public private(set) var isPresentingShortcuts = false
    public var isEditingWebText: (@MainActor () async -> Bool)?
    /// The navigation the Leave this page? alert holds while it asks (`blocker.location`).
    public private(set) var leaveConfirmation: NativeRoute?

    @ObservationIgnored private let loadSettings: @Sendable () async throws -> NativeAppSettings
    @ObservationIgnored private let saveHiddenSections: @MainActor ([NavSectionID: Bool]) -> Void
    @ObservationIgnored private let onNavigate: @MainActor (MenuAction) -> Void
    @ObservationIgnored private let copyToClipboard: @MainActor (String) -> Bool
    @ObservationIgnored private let clipboardNoticeSource = UUID()
    @ObservationIgnored private var clipboardNoticeID = 0
    @ObservationIgnored private let onSidebarVisibilityChange: @MainActor (Bool) -> Void
    @ObservationIgnored private var settingsTask: Task<Void, Never>?
    @ObservationIgnored private var delayedSettingsTask: Task<Void, Never>?
    @ObservationIgnored private let settingsReloadDelay: Duration
    @ObservationIgnored private var shortcuts = NativeShortcuts()
    @ObservationIgnored private var leaveGuard: NativeLeaveGuard?
    @ObservationIgnored private var needsInitialRouteActivation = false
    @ObservationIgnored private let priceNoticeSource = UUID()

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
        notices noticeCenter: NativeNoticeCenter? = nil,
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
        researchForecast: ResearchForecastScreens? = nil,
        researchChartBuilder: ResearchChartBuilderModel? = nil,
        researchDossiers: ResearchDossiersModel? = nil,
        aiChat: AIChatScreens? = nil,
        nativeSettings: NativeSettingsModel? = nil,
        settingsAI: NativeSettingsAIModel? = nil,
        settingsBackup: NativeSettingsBackupModel? = nil,
        settingsAbout: NativeSettingsAboutModel? = nil,
        commandPalette: NativeCommandPaletteModel? = nil,
        shellNotifications: NativeShellNotificationsModel? = nil,
        onboarding: NativeOnboardingModel? = nil,
        reports: NativeReportModel? = nil,
        nativeFallback: Bool = false,
        initialRoute: NativeRoute = .home,
        nativeNavigation: NativeNavigationHistory? = nil,
        hiddenSections: [NavSectionID: Bool]? = nil,
        loadSettings: @escaping @Sendable () async throws -> NativeAppSettings,
        saveHiddenSections: @escaping @MainActor ([NavSectionID: Bool]) -> Void = { _ in },
        onNavigate: @escaping @MainActor (MenuAction) -> Void,
        copyToClipboard: @escaping @MainActor (String) -> Bool = { _ in false },
        onSidebarVisibilityChange: @escaping @MainActor (Bool) -> Void = { _ in },
        settingsReloadDelay: Duration = .milliseconds(600)
    ) {
        self.strings = strings
        self.theme = theme
        self.exchangeRates = exchangeRates
        self.notices = noticeCenter ?? NativeNoticeCenter()
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
        self.researchForecast = researchForecast
        self.researchChartBuilder = researchChartBuilder
        self.researchDossiers = researchDossiers
        self.aiChat = aiChat
        self.nativeSettings = nativeSettings
        self.settingsAI = settingsAI
        self.settingsBackup = settingsBackup
        self.settingsAbout = settingsAbout
        self.commandPalette = commandPalette
        self.shellNotifications = shellNotifications
        self.onboarding = onboarding
        self.reports = reports
        self.nativeFallback = nativeFallback
        self.nativeNavigation = nativeNavigation
        self.route = nativeNavigation?.location.route ?? initialRoute
        self.needsInitialRouteActivation = nativeNavigation == nil && initialRoute != .home
        self.hiddenSections = hiddenSections ?? Self.defaultHiddenSections
        self.loadSettings = loadSettings
        self.saveHiddenSections = saveHiddenSections
        self.onNavigate = onNavigate
        self.copyToClipboard = copyToClipboard
        self.onSidebarVisibilityChange = onSidebarVisibilityChange
        self.settingsReloadDelay = settingsReloadDelay
        commandPalette?.onAction = { [weak self] action in self?.activatePaletteAction(action) }
        shellNotifications?.fx.attachNotices(notices)
        onboarding?.attachNotices(notices)
        onboarding?.strings = strings
        onboarding?.navigate = { [weak self] path in self?.navigate(to: path) }
        onboarding?.openSettings = { [weak self] section in
            guard let self else { return }
            if self.nativeNavigation != nil { self.openNativeSettings(section: section) }
            else { self.onNavigate(.navigate(self.route.setting("settings", to: section).string)) }
        }
        onboarding?.didComplete = { [weak self] in self?.isPresentingOnboarding = false }
        onboarding?.didMutateCategories = { [weak self] in
            self?.categories.invalidate()
            self?.home?.invalidate()
            self?.statistics?.model.invalidate()
            self?.settingsRevision &+= 1
        }
        onboarding?.didMutateImports = { [weak self] in
            guard let self else { return }
            self.categories.invalidate()
            self.recipients.invalidate()
            self.planned.invalidate()
            await self.portfolioDataDidMutate()
        }
        transactions.attach(self)
        accounts.attach(self)
        categories.attach(self)
        recipients.attach(self)
        transactions.attachNotices(notices)
        recipients.attachNotices(notices)
        categories.attachNotices(notices)
        planned.attachNotices(notices)
        researchForecast?.life.attachNotices(notices)
        researchChartBuilder?.attachNotices(notices)
        aiChat?.chat.attachNotices(notices)
        accounts.attachNotices(notices)
        owes.attachNotices(notices)
        exchangeRates.attachNotices(notices)
        imports.toasts.attachNotices(notices)
        imports.toasts.navigateTo = { [weak self] in self?.navigate(to: $0) }
        admin.overview.attachNotices(notices)
        admin.providers.attachNotices(notices)
        admin.database.attachNotices(notices)
        portfolio?.editing.attachNotices(notices)
        portfolio?.netWorth.attachNotices(notices)
        portfolio?.rebalance.attachNotices(notices)
        portfolio?.tax.attachNotices(notices)
        portfolio?.model.didPriceRefresh = { [weak self] in self?.publishPriceRefresh($0) }
        portfolio?.netWorth.didPriceRefresh = { [weak self] in self?.publishPriceRefresh($0) }
        research?.watchlist.attachNotices(notices)
        research?.watchlistAdd.attachNotices(notices)
        research?.lookup.action.attachNotices(notices)
    }

    /// `DEFAULT_HIDDEN` of useSidebarPreferences.
    public static var defaultHiddenSections: [NavSectionID: Bool] {
        var hidden: [NavSectionID: Bool] = [:]
        for section in NavigationRegistry.sections where section.defaultHidden { hidden[section.id] = true }
        return hidden
    }

    // MARK: Route

    private var matchedScreen: NativeScreen? {
        if let location = nativeNavigation?.location { return location.match?.screen }
        return NativeScreen.screen(forPath: route.path)
    }

    /// The native screen for the route, or the web app. A native screen is shown once
    /// `app_settings` has been read (its formats and default currency); an admin screen only
    /// while it says admin mode is on, otherwise the page shows the route and its
    /// `RequireAdmin` redirects, which the page then reports.
    public var detail: NativeShellDetail {
        guard !needsInitialRouteActivation, !isPresentingWeb,
            onboarding != nil || !isPresentingOnboarding, settingsLoaded
        else {
            return .web
        }
        guard let screen = matchedScreen else {
            if route.path == "/portfolio/performance" { return .web }
            return nativeFallback ? .notFound : .web
        }
        if screen.requiresAdmin && !settings.adminMode { return .web }
        if screen == .home && home == nil { return .web }
        if screen == .statistics && (statistics == nil || reports == nil && route.value("export") == "pdf") {
            return .web
        }
        if screen == .tax && (tax == nil || reports == nil && route.value("export") == "pdf") { return .web }
        if screen.path == "/portfolio" || screen.path.hasPrefix("/portfolio/") {
            if portfolio == nil || reports == nil && route.value("export") == "pdf" { return .web }
        }
        if screen == .portfolioTax && tax == nil { return .web }
        if screen == .portfolioImport && portfolioImports == nil { return .web }
        if case .portfolioImportReview = screen, portfolioImports == nil { return .web }
        if screen == .analysis && analysis == nil { return .web }
        if screen == .analysisMonitors && analysisMonitors == nil { return .web }
        if screen == .researchForecast && researchForecast == nil { return .web }
        if screen == .researchChartBuilder && researchChartBuilder == nil { return .web }
        if screen == .researchDossiers && researchDossiers == nil { return .web }
        if screen == .aiChat && aiChat == nil { return .web }
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
        route.path == path
            && (isPresentingWeb || isPresentingOnboarding || isPresentingNativeOverlay
                || route.value("settings") != nil)
    }

    /// `shell:route-changed`: the page's router moved, or an overlay closed on the same route.
    public func routeDidChange(_ next: NativeRoute) {
        guard nativeNavigation == nil else { return }
        needsInitialRouteActivation = false
        applyRouteChange(next)
    }

    private func applyRouteChange(_ next: NativeRoute) {
        let pathChanged = next.path != route.path
        if pathChanged {
            reports?.didLeavePage()
            if route.path == "/analysis" { analysis?.didDisappear() }
            research?.didDisappear(route: route)
            if route.path == "/research/forecast" { researchForecast?.didDisappear() }
            if route.path == "/research/charts" { researchChartBuilder?.didDisappear() }
            if route.path == "/research/dossiers" { researchDossiers?.didDisappear() }
            if route.path == "/ai-chat" { aiChat?.didDisappear() }
            if route.path == "/research/market" { removeLeaveGuard(id: route.path) }
        }
        let settingsClosed = route.value("settings") != nil && next.value("settings") == nil
        let webSettingsClosed = settingsClosed && nativeSettings == nil
        let reportClosed = route.value("export") == "pdf" && next.value("export") != "pdf"
        // A new page, the settings dialog closing (`?settings` removed), or the same route
        // again (the palette or shortcuts overlay closed) ends a web presentation over a
        // native screen.
        if pathChanged || settingsClosed || reportClosed || next == route { isPresentingWeb = false }
        pendingRoute = nil
        route = next
        if let reports {
            if next.value("export") == "pdf", let type = Self.reportType(for: next.path) {
                if !reports.isPresented { reports.configure(type: type, origin: next.string) }
            } else if reports.isPresented {
                reports.didDisappear()
            }
        }
        if pathChanged { leaveConfirmation = nil }
        if nativeNavigation != nil {
            if case .some(.tableEditor(let table)) = matchedScreen { admin.database.routeDidChange(table: table) }
            else { admin.database.routeDidChange(table: nil) }
        } else {
            admin.database.routeDidChange(path: next.path)
        }
        // ⌘N's pending Add sheet belongs to the arrival at `/transactions`; landing elsewhere
        // (a redirect, the page's own prompt) drops it.
        if next.path != TransactionsRoutes.path { transactions.cancelAddOnArrival() }
        if let section = NavigationRegistry.matchSection(path: next.path), hiddenSections[section] == true {
            // Landing inside a hidden section shows it for good, like the web sidebar.
            setSection(section, expanded: true)
        }
        // The page may have changed `app_settings` (admin mode, formats) in its settings
        // dialog or on the previous page.
        if pathChanged || webSettingsClosed { reloadSettings() }
        // The page saves `app_settings` 500 ms after a change, so a read right after the
        // dialog closes can still see the old values.
        if webSettingsClosed { reloadSettingsLater() }
        if webSettingsClosed { home?.invalidate() }
        if pathChanged && next.path == InsightsRoutes.home { home?.invalidate() }
        if webSettingsClosed || pathChanged && next.path == InsightsRoutes.statistics { statistics?.model.invalidate() }
        if webSettingsClosed || pathChanged && next.path == "/tax" { tax?.invalidate() }
        if webSettingsClosed || pathChanged && next.path == "/portfolio/tax" { tax?.invalidate() }
        if webSettingsClosed || pathChanged && (next.path == "/portfolio" || next.path.hasPrefix("/portfolio/")) {
            portfolio?.invalidate()
        }
        if webSettingsClosed || pathChanged && next.path.hasPrefix("/portfolio/import") {
            portfolioImports?.invalidate()
        }
        if webSettingsClosed || pathChanged && next.path == "/analysis" { analysis?.invalidate() }
        if webSettingsClosed || pathChanged && next.path == "/analysis/monitors" { analysisMonitors?.invalidate() }
    }

    /// A sidebar click, a menu or shortcut navigation, or another native link. The page moves
    /// (or keeps its route behind its own unsaved-changes prompt) and reports the result; until
    /// then the route stays. While a native screen has unsaved changes, a navigation to another
    /// path waits on the Leave this page? alert instead (`useBlocker`).
    public func navigate(to url: String) {
        if nativeNavigation != nil {
            guard let next = NativeNavigationLocation(url) else { return }
            requestNativeNavigation(.push(next))
            return
        }
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
        if nativeNavigation != nil {
            guard let next = NativeNavigationLocation(url) else { return }
            requestNativeNavigation(.replace(next))
            return
        }
        guard let next = NativeRoute(url) else { return }
        pendingRoute = next
        onNavigate(.replaceRoute(next.string))
    }
    /// The existing report dialog owns PDF rendering and report serialization.
    public func openStatisticsReport() {
        guard route.path == InsightsRoutes.statistics else { return }
        if nativeNavigation != nil { replaceQuery("export", with: "pdf"); return }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    public func openTaxReport() {
        guard route.path == "/tax" else { return }
        if nativeNavigation != nil { replaceQuery("export", with: "pdf"); return }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    public func openPortfolioReport() {
        switch matchedScreen {
        case .portfolio, .portfolioHoldings: break
        default: return
        }
        if nativeNavigation != nil { replaceQuery("export", with: "pdf"); return }
        isPresentingWeb = true
        replace(with: route.setting("export", to: "pdf").string)
    }

    private func send(_ next: NativeRoute) {
        pendingRoute = next
        onNavigate(.navigate(next.string))
    }

    public func goBack() { requestNativeNavigation(.traverse(-1)) }
    public func goForward() { requestNativeNavigation(.traverse(1)) }

    private var nativeAdminMode: Bool? { settingsLoaded ? settings.adminMode : nil }

    private func requestNativeNavigation(_ intent: NativeNavigationHistory.Intent) {
        guard var history = nativeNavigation else { return }
        let outcome = history.request(intent, adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
    }

    private func applyNativeNavigation(_ outcome: NativeNavigationHistory.Outcome) {
        switch outcome {
        case .committed(let location):
            leaveConfirmation = nil
            pendingRoute = nil
            applyRouteChange(location.route)
        case .blocked(let location):
            pendingRoute = nil
            leaveConfirmation = location.route
        case .waitingForSettings:
            leaveConfirmation = nil
        case .unchanged:
            if nativeNavigation?.pending == nil { leaveConfirmation = nil }
        }
    }

    private func openNativeSettings(section: String) {
        guard var history = nativeNavigation else { return }
        let outcome = history.openSettings(section: section, adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
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

    private func publishPriceRefresh(_ receipt: PortfolioPriceRefreshReceipt) {
        let kind: ScreenNotice.Kind
        let key: String
        let variables: [String: String]
        let detail: String?
        if let error = receipt.error {
            kind = .error
            key = "portfolio.refreshPricesFailedTitle"
            variables = [:]
            detail = receipt.offline ? strings.t("portfolio.refreshPricesOffline") : error
        } else if let result = receipt.result {
            kind = result.staleCount > 0 ? .warning : .success
            key = "portfolio.refreshedPrices"
            variables = ["n": String(result.total ?? 0)]
            detail =
                result.staleCount > 0
                ? strings.t(
                    "portfolio.refreshedPricesStale",
                    ["n": String(result.staleCount), "total": String(result.total ?? 0)])
                : nil
        } else {
            return
        }
        notices.publish(
            .init(id: 0, kind: kind, key: key, variables: variables, detail: detail),
            source: priceNoticeSource, replacementKey: "portfolio-refresh-prices")
    }

    /// Import cash and trades can become durable after the user has opened another screen.
    public func portfolioImportDidMutate() async { await portfolioDataDidMutate() }

    /// Portfolio/import/research writes retire sibling reads even when their acknowledgement is lost.
    public func portfolioDataDidMutate() async {
        research?.portfolioDataDidChange()
        researchForecast?.portfolioDataDidChange()
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
        case .researchForecast:
            researchForecast?.configure(settings: currentSettings)
            await researchForecast?.load(force: true)
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
        nativeNavigation?.cancelPending()
        leaveConfirmation = nil
        transactions.cancelAddOnArrival()
    }

    /// Leave and discard (`blocker.proceed`): the unsaved work is dropped and the navigation
    /// continues.
    public func leavePage() {
        guard let next = leaveConfirmation else { return }
        if var history = nativeNavigation {
            leaveGuard?.discard()
            let outcome = history.confirmPending(adminMode: nativeAdminMode)
            nativeNavigation = history
            applyNativeNavigation(outcome)
            return
        }
        leaveConfirmation = nil
        leaveGuard?.discard()
        send(next)
    }

    /// `setSearchParams(..., { replace: true })` for the current route; `nil` deletes the
    /// parameter (`useSearchParamState` writing a default value).
    public func replaceQuery(_ name: String, with value: String?) {
        if let history = nativeNavigation {
            guard let next = history.location.setting(name, to: value) else { return }
            requestNativeNavigation(.replace(next))
            return
        }
        let next = value.map { route.setting(name, to: $0) } ?? route.removing(name)
        route = next
        onNavigate(.replaceRoute(next.string))
    }

    /// `setSearchParams(next, { replace: true })` with a whole new query for the current path
    /// (the sort pair, written together).
    public func replaceQuery(_ query: [URLQueryItem]) {
        if let history = nativeNavigation {
            guard let next = history.location.replacingQuery(query) else { return }
            requestNativeNavigation(.replace(next))
            return
        }
        let next = NativeRoute(path: route.path, query: query)
        route = next
        onNavigate(.replaceRoute(next.string))
    }

    public func openSettings() {
        if nativeNavigation != nil { openNativeSettings(section: "general"); return }
        willPresent(.openSettings)
        onNavigate(.openSettings)
    }

    public var settingsSection: String? {
        guard let section = route.value("settings"),
            ["general", "appearance", "statistics", "behavior", "ai", "backup", "about"].contains(section)
        else { return nil }
        return section
    }
    public var isPresentingNativeSettings: Bool { nativeSettings != nil && settingsSection != nil }
    public func selectSettingsSection(_ section: String) {
        guard isPresentingNativeSettings,
            ["general", "appearance", "statistics", "behavior", "ai", "backup", "about"].contains(section)
        else { return }
        if nativeNavigation != nil { openNativeSettings(section: section); return }
        replace(with: route.setting("settings", to: section).string)
    }
    public func closeSettings() {
        if var history = nativeNavigation {
            let outcome = history.closeSettings(adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
            nativeNavigation = history
            applyNativeNavigation(outcome)
        } else { onNavigate(.closeSettings) }
    }

    public var nativeOverlayKind: NativeShellOverlayKind? {
        // A restore seed has not yet been accepted by the new document generation.
        // Mounting Settings now would let its .task start storage reads before readiness.
        guard !needsInitialRouteActivation else { return nil }
        if commandPalette?.isOpen == true { return .palette }
        if isPresentingShortcuts { return .shortcuts }
        if isPresentingNativeSettings { return .settings }
        if reports?.isPresented == true { return .report }
        if onboarding?.isPresented == true { return .onboarding }
        return nil
    }
    public var isPresentingNativeOverlay: Bool { nativeOverlayKind != nil }
    public func openPalette() {
        guard !isReloadingGraph, nativeSettings?.isSuspendedForRestore != true else { return }
        guard let commandPalette else {
            willPresent(.openPalette)
            onNavigate(.openPalette)
            return
        }
        commandPalette.configure(settings: settings)
        commandPalette.open()
    }
    public func closePalette() { commandPalette?.close() }
    public func openShortcuts() {
        guard !isReloadingGraph, nativeSettings?.isSuspendedForRestore != true else { return }
        if commandPalette == nil {
            willPresent(.openShortcuts)
            onNavigate(.openShortcuts)
        } else {
            isPresentingShortcuts = true
        }
    }
    public func closeShortcuts() { isPresentingShortcuts = false }
    public func closeReport() {
        reports?.didDisappear()
        if route.value("export") == "pdf" { replaceQuery("export", with: nil) }
    }
    public func closeNativeOverlay() async {
        switch nativeOverlayKind {
        case .palette: closePalette()
        case .shortcuts: closeShortcuts()
        case .settings: closeSettings()
        case .report: reports?.close()
        case .onboarding: await onboarding?.finish()
        case nil: break
        }
    }
    public func activatePaletteAction(_ action: NativeCommandPaletteAction) {
        guard !isReloadingGraph, nativeSettings?.isSuspendedForRestore != true else { return }
        switch action {
        case .navigate(let route): navigate(to: route.string)
        case .newTransaction:
            if !newTransaction() { navigate(to: TransactionsRoutes.newTransactionRoute) }
        case .theme(let mode): nativeSettings?.updateTheme(["mode": .string(mode)])
        case .settings: openSettings()
        case .shortcuts: openShortcuts()
        case .copy(let value):
            if copyToClipboard(value) {
                clipboardNoticeID += 1
                notices.publish(
                    .init(id: clipboardNoticeID, kind: .success, key: "commandPalette.copied"),
                    source: clipboardNoticeSource)
            }
        }
    }
    private static func reportType(for path: String) -> NativeReportType? {
        if path == "/statistics" { return .financial }
        if path == "/tax" { return .tax }
        if path == "/portfolio" || path == "/portfolio/net-worth"
            || ["stocks", "crypto", "metals", "real-estate", "savings"].contains(where: { path == "/portfolio/" + $0 })
        {
            return .portfolio
        }
        return nil
    }

    /// A menu action is about to reach the page. One that opens a page dialog shows the web
    /// view, since the dialog belongs to the page.
    public func willPresent(_ action: MenuAction) {
        if action == .openSettings, nativeSettings != nil { return }
        if action == .openPalette, commandPalette != nil {
            openPalette()
            return
        }
        if action == .openShortcuts, commandPalette != nil {
            openShortcuts()
            return
        }
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
        guard !isReloadingGraph else { return true }
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
            openPalette()
            return true
        case .openShortcuts:
            openShortcuts()
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
        let firstSettingsLoad = !settingsLoaded
        // Display formats and language do not change financial query data. Retire
        // currency-dependent snapshots only when their data dependency changes.
        if settingsLoaded, next.defaultCurrency != settings.defaultCurrency {
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
        commandPalette?.configure(settings: next)
        onboarding?.strings = strings
        if var history = nativeNavigation {
            let outcome = history.settingsDidLoad(adminMode: next.adminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
            nativeNavigation = history
            applyNativeNavigation(outcome)
            if firstSettingsLoad, outcome == .unchanged { applyRouteChange(history.location.route) }
        } else if needsInitialRouteActivation, isRendererReady {
            needsInitialRouteActivation = false
            applyRouteChange(route)
        }
    }

    /// Reads `app_settings` again; the page may have changed them. A newer request
    /// replaces a pending one, and a failure keeps the last known settings.
    public func reloadSettings() {
        settingsTask?.cancel()
        let load = loadSettings
        let revision = settingsRevision
        settingsTask = Task { [weak self] in
            guard let loaded = try? await load(), !Task.isCancelled, self?.settingsRevision == revision else { return }
            self?.apply(settings: loaded)
        }
    }

    /// Server-owned projections read persisted Settings. Retire only their actual
    /// dependencies after acknowledgement; presentation-only edits keep cached data.
    public func nativeSettingsDidAcknowledge(_ key: String, value: TaxValue) {
        switch key {
        case "dashboard_settings", "includeTransfers":
            home?.invalidate()
            statistics?.model.invalidate()
            settingsRevision &+= 1
        case "cost_basis_method":
            portfolio?.dataDidChange()
            settingsRevision &+= 1
        case "brokerage_cash_category_ids":
            portfolioImports?.invalidate()
            portfolio?.tax.invalidate()
            settingsRevision &+= 1
        default: break
        }
    }

    public func nativePreferencesDidReset() async {
        home?.invalidate()
        statistics?.model.invalidate()
        portfolio?.invalidate()
        analysis?.invalidate()
        analysisMonitors?.invalidate()
        settingsRevision &+= 1
    }

    public func exchangeRatesDidRefresh() {
        exchangeRates.invalidate()
        home?.invalidate()
        statistics?.model.invalidate()
        portfolio?.invalidate()
        settingsRevision &+= 1
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
