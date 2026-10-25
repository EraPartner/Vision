import Foundation
import Observation

/// What the detail column shows for the current route.
public enum NativeShellDetail: Equatable, Sendable {
    case native(NativeScreen)
    case notFound
    case loading
    case unavailable
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

/// The state behind the native shell: the route (owned by native history), the
/// `app_settings` native screens read, the theme and the sidebar.
///
/// Native history is the only route authority. A sidebar click, menu action or link asks the
/// history for a push or replace; the history applies the admin and legacy redirects and holds
/// a navigation while a native screen has unsaved changes (the Leave this page? alert).
@MainActor
@Observable
public final class NativeShellModel {
    public private(set) var route: NativeRoute = .home
    public private(set) var settings: NativeAppSettings = .defaults
    /// `false` until `app_settings` has been read once; native screens wait for it.
    public private(set) var settingsLoaded = false
    public private(set) var nativeDocumentState: NativeDocumentState = .loading
    private var initialSettingsLoadFailed = false
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
    /// Native history: the route authority.
    public private(set) var nativeNavigation: NativeNavigationHistory
    public var nativeNavigationLocation: NativeNavigationLocation { nativeNavigation.location }
    public var canGoBack: Bool { nativeNavigation.canGoBack }
    public var canGoForward: Bool { nativeNavigation.canGoForward }
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
    /// `NavItemBadge` counts; the SDK supplies it, and the sidebar shows none without it.
    public var sidebarBadges: NativeSidebarBadgesModel?
    /// DevtoolsRoot's API Inspector; shown only in admin mode.
    public var apiInspector: NativeAPIInspectorModel?

    /// Scroll offsets per native history visit, restored only on Back/Forward like the
    /// web table's history-entry scroll restoration.
    @ObservationIgnored private var scrollOffsets: [UUID: Double] = [:]

    /// The offset to restore for the current visit: only when it was reached by Back/Forward.
    public func restorableScrollOffset() -> Double? {
        guard nativeNavigation.lastCommitWasTraversal else { return nil }
        return scrollOffsets[nativeNavigation.entryID]
    }

    public func recordScrollOffset(_ offset: Double) {
        scrollOffsets[nativeNavigation.entryID] = max(0, offset)
    }

    /// The count beside a sidebar row, 0 when none is shown.
    public func badgeCount(_ badge: NavBadge) -> Int {
        sidebarBadges?.count(for: badge, plannedDue: shellNotifications?.upcoming.visibleUpcoming.count ?? 0) ?? 0
    }
    public let onboarding: NativeOnboardingModel?
    public let reports: NativeReportModel?
    public private(set) var isPresentingShortcuts = false
    /// ErrorBoundary's Reload page: View › Reload for the current graph (set by the app).
    public var reloadPage: (@MainActor () -> Void)?
    /// The navigation the Leave this page? alert holds while it asks (`blocker.location`).
    public private(set) var leaveConfirmation: NativeRoute?

    @ObservationIgnored private let loadSettings: @Sendable () async throws -> NativeAppSettings
    @ObservationIgnored private let saveHiddenSections: @MainActor ([NavSectionID: Bool]) -> Void
    @ObservationIgnored private let copyToClipboard: @MainActor (String) -> Bool
    @ObservationIgnored private let clipboardNoticeSource = UUID()
    @ObservationIgnored private var clipboardNoticeID = 0
    @ObservationIgnored private let onSidebarVisibilityChange: @MainActor (Bool) -> Void
    @ObservationIgnored private var settingsTask: Task<Void, Never>?
    @ObservationIgnored private var shortcuts = NativeShortcuts()
    @ObservationIgnored private var leaveGuard: NativeLeaveGuard?
    @ObservationIgnored private let priceNoticeSource = UUID()
    @ObservationIgnored private let nativeIntents: NativeShellIntentCoordinator
    @ObservationIgnored private var nativeIntentLease: NativeShellIntentCoordinator.Lease
    @ObservationIgnored private var nativeIntentConsumer: NativeScreen?

    /// - Parameters:
    ///   - hiddenSections: the stored section choices; `nil` uses the `defaultHidden` flags.
    ///   - nativeNavigation: the history to start from; `nil` starts at `initialRoute`.
    ///   - nativeIntents: the session's intent coordinator, kept across graph rebuilds; `nil`
    ///     gives this graph its own.
    ///   - onSidebarVisibilityChange: the sidebar was shown or hidden.
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
        initialRoute: NativeRoute = .home,
        nativeNavigation: NativeNavigationHistory? = nil,
        nativeIntents: NativeShellIntentCoordinator? = nil,
        hiddenSections: [NavSectionID: Bool]? = nil,
        loadSettings: @escaping @Sendable () async throws -> NativeAppSettings,
        saveHiddenSections: @escaping @MainActor ([NavSectionID: Bool]) -> Void = { _ in },
        copyToClipboard: @escaping @MainActor (String) -> Bool = { _ in false },
        onSidebarVisibilityChange: @escaping @MainActor (Bool) -> Void = { _ in }
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
        let coordinator = nativeIntents ?? NativeShellIntentCoordinator()
        let attachment = coordinator.attach(
            initialHistory: nativeNavigation
                ?? NativeNavigationHistory(initial: NativeNavigationLocation(initialRoute.string) ?? .home))
        self.nativeIntents = coordinator
        self.nativeIntentLease = attachment.lease
        self.nativeNavigation = attachment.history
        self.route = attachment.history.location.route
        self.hiddenSections = hiddenSections ?? Self.defaultHiddenSections
        self.loadSettings = loadSettings
        self.saveHiddenSections = saveHiddenSections
        self.copyToClipboard = copyToClipboard
        self.onSidebarVisibilityChange = onSidebarVisibilityChange
        commandPalette?.onAction = { [weak self] action in self?.activatePaletteAction(action) }
        shellNotifications?.fx.attachNotices(notices)
        onboarding?.attachNotices(notices)
        onboarding?.strings = strings
        onboarding?.navigate = { [weak self] path in self?.navigate(to: path) }
        onboarding?.openSettings = { [weak self] section in self?.openNativeSettings(section: section) }
        onboarding?.didComplete = { [weak self] in
            self?.nativeIntentReadinessDidChange()
        }
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
        statistics?.saved.attachNotices(notices)
        recipients.attachNotices(notices)
        categories.attachNotices(notices)
        planned.attachNotices(notices)
        researchChartBuilder?.attachNotices(notices)
        aiChat?.chat.attachNotices(notices)
        accounts.attachNotices(notices)
        owes.attachNotices(notices)
        exchangeRates.attachNotices(notices)
        imports.toasts.attachNotices(notices)
        imports.toasts.navigateTo = { [weak self] in self?.navigate(to: $0) }
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
        nativeNavigation.location.match?.screen
    }

    /// The native screen for the route, or the startup, not-found and unavailable states. A
    /// native screen is shown once the host marked the document ready and `app_settings` has
    /// been read (its formats and default currency); an admin screen only while it says admin
    /// mode is on (the history redirects the route otherwise).
    public var detail: NativeShellDetail {
        guard nativeDocumentState != .failed, !initialSettingsLoadFailed else { return .unavailable }
        guard nativeDocumentState == .ready, settingsLoaded, !isReloadingGraph else { return .loading }
        guard route.value("settings") == nil || nativeSettings != nil,
            route.value("export") != "pdf" || reports != nil
        else { return .unavailable }
        guard let screen = matchedScreen else { return .notFound }
        return nativeScreenDetail(screen)
    }

    /// The SDK must also apply its existing overlay, restore and operation fences.
    /// In particular a cached native snapshot must not print while native startup is pending.
    public var printDisposition: NativeShellPrintDisposition {
        switch detail {
        case .native: return .nativePage
        case .notFound, .loading, .unavailable: return .unavailable
        }
    }

    /// Called only by the native document owner after its independent document/generation
    /// checks. This display state neither authenticates a document nor releases SDK gates.
    public func setNativeDocumentState(_ state: NativeDocumentState) {
        nativeDocumentState = state
    }

    public var canRetryInitialSettings: Bool {
        initialSettingsLoadFailed && nativeDocumentState == .ready
    }

    /// The screen, unless the model it needs was not supplied (shell-only test fixtures), which
    /// shows the unavailable state.
    private func nativeScreenDetail(_ screen: NativeScreen) -> NativeShellDetail {
        if screen.requiresAdmin && !settings.adminMode { return .unavailable }
        if screen == .home && home == nil { return .unavailable }
        if screen == .statistics && (statistics == nil || reports == nil && route.value("export") == "pdf") {
            return .unavailable
        }
        if screen == .tax && (tax == nil || reports == nil && route.value("export") == "pdf") { return .unavailable }
        if screen.path == "/portfolio" || screen.path.hasPrefix("/portfolio/") {
            if portfolio == nil || reports == nil && route.value("export") == "pdf" { return .unavailable }
        }
        if screen == .portfolioTax && tax == nil { return .unavailable }
        if screen == .portfolioImport && portfolioImports == nil { return .unavailable }
        if case .portfolioImportReview = screen, portfolioImports == nil { return .unavailable }
        if screen == .analysis && analysis == nil { return .unavailable }
        if screen == .analysisMonitors && analysisMonitors == nil { return .unavailable }
        if screen == .researchForecast && researchForecast == nil { return .unavailable }
        if screen == .researchChartBuilder && researchChartBuilder == nil { return .unavailable }
        if screen == .researchDossiers && researchDossiers == nil { return .unavailable }
        if screen == .aiChat && aiChat == nil { return .unavailable }
        if [
            .researchHome, .researchMarkets, .researchMarketLookup, .researchWatchlist, .researchCompare,
        ].contains(
            screen),
            research == nil
        {
            return .unavailable
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

    /// Settings and global overlays cover the native view of the route they are shown over.
    public func isTemporarilyCovered(_ path: String) -> Bool {
        route.path == path
            && (isPresentingNativeOverlay || route.value("settings") != nil)
    }

    private func applyRouteChange(_ next: NativeRoute) {
        let pathChanged = next.path != route.path
        if next.path != TransactionsRoutes.path {
            nativeIntents.cancelNewTransaction(for: nativeIntentLease)
        }
        if pathChanged {
            nativeIntentConsumer = nil
            reports?.didLeavePage()
            if route.path == "/analysis" { analysis?.didDisappear() }
            research?.didDisappear(route: route)
            if route.path == "/research/forecast" { researchForecast?.didDisappear() }
            if route.path == "/research/charts" { researchChartBuilder?.didDisappear() }
            if route.path == "/research/dossiers" { researchDossiers?.didDisappear() }
            if route.path == "/ai-chat" { aiChat?.didDisappear() }
            if route.path == "/research/market" { removeLeaveGuard(id: route.path) }
        }
        route = next
        if let reports {
            if next.value("export") == "pdf", let type = Self.reportType(for: next.path) {
                if !reports.isPresented { reports.configure(type: type, origin: next.string) }
            } else if reports.isPresented {
                reports.didDisappear()
            }
        }
        if pathChanged { leaveConfirmation = nil }
        if case .some(.tableEditor(let table)) = matchedScreen { admin.database.routeDidChange(table: table) }
        else { admin.database.routeDidChange(table: nil) }
        if let section = NavigationRegistry.matchSection(path: next.path), hiddenSections[section] == true {
            // Landing inside a hidden section shows it for good, like the web sidebar.
            setSection(section, expanded: true)
        }
        // Another page may have changed `app_settings` (admin mode, formats).
        if pathChanged { reloadSettings() }
        if pathChanged && next.path == InsightsRoutes.home { home?.invalidate() }
        if pathChanged && next.path == InsightsRoutes.statistics { statistics?.model.invalidate() }
        if pathChanged && next.path == "/tax" { tax?.invalidate() }
        if pathChanged && next.path == "/portfolio/tax" { tax?.invalidate() }
        if pathChanged && (next.path == "/portfolio" || next.path.hasPrefix("/portfolio/")) {
            portfolio?.invalidate()
        }
        if pathChanged && next.path.hasPrefix("/portfolio/import") { portfolioImports?.invalidate() }
        if pathChanged && next.path == "/analysis" { analysis?.invalidate() }
        if pathChanged && next.path == "/analysis/monitors" { analysisMonitors?.invalidate() }
    }

    /// A sidebar click, a menu or shortcut navigation, or another native link: pushes a history
    /// entry. While a native screen has unsaved changes, a navigation to another path waits on
    /// the Leave this page? alert instead (`useBlocker`).
    public func navigate(to url: String) {
        guard let next = NativeNavigationLocation(url) else { return }
        requestNativeNavigation(.push(next))
    }

    /// `navigate(url, { replace: true })` from a native screen (Review import's Commit and
    /// Discard): the current history entry is replaced.
    public func replace(with url: String) {
        guard let next = NativeNavigationLocation(url) else { return }
        requestNativeNavigation(.replace(next))
    }

    /// The report overlay owns PDF rendering and report serialization.
    public func openStatisticsReport() {
        guard route.path == InsightsRoutes.statistics else { return }
        replaceQuery("export", with: "pdf")
    }

    public func openTaxReport() {
        guard route.path == "/tax" else { return }
        replaceQuery("export", with: "pdf")
    }

    public func openPortfolioReport() {
        switch matchedScreen {
        case .portfolio, .portfolioHoldings: break
        default: return
        }
        replaceQuery("export", with: "pdf")
    }

    public func goBack() { requestNativeNavigation(.traverse(-1)) }
    public func goForward() { requestNativeNavigation(.traverse(1)) }

    private var nativeAdminMode: Bool? { settingsLoaded ? settings.adminMode : nil }

    private func requestNativeNavigation(_ intent: NativeNavigationHistory.Intent) {
        var history = nativeNavigation
        let outcome = history.request(intent, adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
    }

    private func applyNativeNavigation(_ outcome: NativeNavigationHistory.Outcome) {
        nativeIntents.checkpoint(nativeNavigation, for: nativeIntentLease)
        switch outcome {
        case .committed(let location):
            leaveConfirmation = nil
            applyRouteChange(location.route)
        case .blocked(let location):
            leaveConfirmation = location.route
        case .waitingForSettings:
            leaveConfirmation = nil
        case .unchanged:
            if nativeNavigation.pending == nil { leaveConfirmation = nil }
        }
    }

    private func openNativeSettings(section: String) {
        var history = nativeNavigation
        let outcome = history.openSettings(
            section: section, adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
    }

    /// A CSV opened from Finder or the dock, or dropped on a native screen: the native import
    /// card gets the file (pre-filled, not started, within the handoff's 30 seconds) once the
    /// document, settings and onboarding are ready, and the shell moves to `/import`. Returns
    /// `false` when this graph has been replaced.
    public func openImportFile(_ file: ImportFile) -> Bool {
        enqueueNativeIntent(.openCSV(file))
    }

    /// ⌘N, the dock menu's New transaction and the `N` shortcut: the Add transaction sheet
    /// opens on the native `/transactions` screen, at once when it is already shown, otherwise
    /// once the shell arrives there. Returns `false` when this graph has been replaced.
    public func newTransaction() -> Bool {
        enqueueNativeIntent(.newTransaction)
    }

    /// Menu admission: each menu or dock action runs through its native owner. Invalid
    /// payloads of known commands are ignored, as in ElectronBridge; an unknown action is
    /// refused.
    @discardableResult
    public func acceptNativeMenuAction(_ action: MenuAction) -> Bool {
        guard hasCurrentNativeIntentLease else { return false }
        let intent: NativeShellIntentCoordinator.Intent
        switch action.action {
        case "new-transaction": intent = .newTransaction
        case "open-settings":
            guard nativeSettings != nil else { return false }
            intent = .openSettings(section: "general")
        case "close-settings":
            guard nativeSettings != nil else { return false }
            intent = .closeSettings
        case "set-theme":
            guard nativeSettings != nil else { return false }
            guard let mode = action.payload, ApplicationMenu.themeModes.contains(where: { $0.id == mode })
            else {
                return true
            }
            intent = .setTheme(mode)
        case "navigate":
            guard let raw = action.payload, let location = NativeNavigationLocation(raw) else {
                return true
            }
            intent = .navigate(location, replace: false)
        case "toggle-sidebar": intent = .toggleSidebar
        case "open-palette":
            guard commandPalette != nil else { return false }
            intent = .openPalette
        case "open-shortcuts":
            guard commandPalette != nil else { return false }
            intent = .openShortcuts
        default: return false
        }
        return enqueueNativeIntent(intent)
    }

    private var hasCurrentNativeIntentLease: Bool {
        nativeIntents.isCurrent(nativeIntentLease)
    }

    private var nativeIntentReadiness: NativeShellIntentCoordinator.Readiness {
        .init(
            document: nativeDocumentState == .ready,
            settings: settingsLoaded && (nativeSettings?.isLoaded ?? true),
            onboarding: (onboarding?.isLoaded ?? true) && onboarding?.isPresented != true,
            acceptingInput: !isReloadingGraph && nativeSettings?.isSuspendedForRestore != true)
    }

    private func enqueueNativeIntent(_ intent: NativeShellIntentCoordinator.Intent) -> Bool {
        guard hasCurrentNativeIntentLease else { return false }
        nativeIntents.enqueue(intent)
        nativeIntentReadinessDidChange()
        return true
    }

    /// The host calls this after document/settings/onboarding/input readiness changes.
    /// It must retain its independent document and generation checks before opening gates.
    public func nativeIntentReadinessDidChange() {
        let readiness = nativeIntentReadiness
        nativeIntents.drain(for: nativeIntentLease, readiness: readiness) { [self] intent in
            switch intent {
            case .openCSV: navigate(to: ImportRoutes.path)
            case .newTransaction: navigate(to: TransactionsRoutes.path)
            case .navigate(let location, let replace):
                requestNativeNavigation(replace ? .replace(location) : .push(location))
            case .openSettings(let section): openNativeSettings(section: section)
            case .closeSettings: closeSettings()
            case .setTheme(let mode): nativeSettings?.updateTheme(["mode": .string(mode)])
            case .toggleSidebar: toggleSidebar()
            case .openPalette: openPalette()
            case .openShortcuts: openShortcuts()
            case .traverse(let delta): requestNativeNavigation(.traverse(delta))
            }
            switch intent {
            case .openCSV, .newTransaction:
                if let pending = nativeNavigation.pending {
                    nativeIntents.preserveBlockedColdNavigation(
                        pending, newTransaction: intent == .newTransaction, for: nativeIntentLease)
                }
            default: break
            }
        }
        guard readiness.isReady, nativeIntents.isCurrent(nativeIntentLease), let nativeIntentConsumer,
            detail == .native(nativeIntentConsumer), !isPresentingNativeOverlay
        else { return }
        if nativeIntentConsumer == .importExport, !imports.isImporting,
            let file = nativeIntents.consumeCSV(for: nativeIntentLease, consumerReady: true)
        {
            imports.chooseFile(file)
        }
        if nativeIntentConsumer == .transactions,
            nativeIntents.consumeNewTransaction(for: nativeIntentLease, consumerReady: true)
        {
            transactions.requestAdd()
        }
    }

    /// The mounted native destination acknowledges readiness only for its current route.
    /// A replacement graph must establish its own consumer readiness before delivery.
    public func nativeIntentConsumerDidBecomeReady(for screen: NativeScreen) {
        guard hasCurrentNativeIntentLease, detail == .native(screen) else { return }
        nativeIntentConsumer = screen
        nativeIntentReadinessDidChange()
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
        nativeNavigation.cancelPending()
        nativeIntents.cancelNewTransaction(for: nativeIntentLease)
        nativeIntents.checkpoint(nativeNavigation, for: nativeIntentLease)
        leaveConfirmation = nil
    }

    /// Leave and discard (`blocker.proceed`): the unsaved work is dropped and the navigation
    /// continues.
    public func leavePage() {
        guard leaveConfirmation != nil else { return }
        var history = nativeNavigation
        leaveGuard?.discard()
        let outcome = history.confirmPending(adminMode: nativeAdminMode)
        nativeNavigation = history
        applyNativeNavigation(outcome)
    }

    /// `setSearchParams(..., { replace: true })` for the current route; `nil` deletes the
    /// parameter (`useSearchParamState` writing a default value).
    public func replaceQuery(_ name: String, with value: String?) {
        guard let next = nativeNavigation.location.setting(name, to: value) else { return }
        requestNativeNavigation(.replace(next))
    }

    /// `setSearchParams(next, { replace: true })` with a whole new query for the current path
    /// (the sort pair, written together).
    public func replaceQuery(_ query: [URLQueryItem]) {
        guard let next = nativeNavigation.location.replacingQuery(query) else { return }
        requestNativeNavigation(.replace(next))
    }

    public func openSettings() {
        openNativeSettings(section: "general")
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
        openNativeSettings(section: section)
    }
    public func closeSettings() {
        var history = nativeNavigation
        let outcome = history.closeSettings(adminMode: nativeAdminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
    }

    public var nativeOverlayKind: NativeShellOverlayKind? {
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
        guard let commandPalette else { return }
        commandPalette.configure(settings: settings)
        commandPalette.open()
    }
    public func closePalette() { commandPalette?.close() }
    public func openShortcuts() {
        guard !isReloadingGraph, nativeSettings?.isSuspendedForRestore != true else { return }
        if commandPalette != nil { isPresentingShortcuts = true }
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

    /// A key press on a native screen. Returns `false` when the key is not a shortcut.
    public func handleKey(
        _ key: String, command: Bool = false, control: Bool = false, option: Bool = false, shift: Bool = false,
        typing: Bool = false, now: Date = Date()
    ) -> Bool {
        guard !isReloadingGraph else { return true }
        switch shortcuts.handle(
            key: key, command: command, control: control, option: option, shift: shift, path: route.path,
            typing: typing, now: now)
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
        case .toggleSidebar:
            toggleSidebar()
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
        initialSettingsLoadFailed = false
        settingsRevision &+= 1
        theme.colorblindGainLoss = next.colorblindGainLoss
        commandPalette?.configure(settings: next)
        onboarding?.strings = strings
        var history = nativeNavigation
        let outcome = history.settingsDidLoad(adminMode: next.adminMode, hasUnsavedChanges: hasGuardedUnsavedChanges)
        nativeNavigation = history
        applyNativeNavigation(outcome)
        if firstSettingsLoad, outcome == .unchanged { applyRouteChange(history.location.route) }
    }

    /// Reads `app_settings` again; another page may have changed them. A newer request
    /// replaces a pending one, and a failure keeps the last known settings.
    public func reloadSettings() {
        settingsTask?.cancel()
        initialSettingsLoadFailed = false
        let load = loadSettings
        let revision = settingsRevision
        settingsTask = Task { [weak self] in
            do {
                let loaded = try await load()
                guard !Task.isCancelled, self?.settingsRevision == revision else { return }
                self?.apply(settings: loaded)
            } catch {
                guard !Task.isCancelled, let self, self.settingsRevision == revision else { return }
                self.initialSettingsLoadFailed = !self.settingsLoaded
            }
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

    /// Waits for the pending settings request, for tests.
    public func settingsSettled() async {
        await settingsTask?.value
    }
}
