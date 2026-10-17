import AppKit
import SwiftUI
import VisionNativeCore

/// The window content of Vision Native from phase 2: a native sidebar built from
/// `NavigationRegistry`, and a detail column that shows a native screen or the web app.
///
/// The web view is passed in by the app target and never leaves the hierarchy, so the page
/// keeps its state; `webContent` receives `true` while a native screen covers it.
public struct ShellRootView<WebContent: View>: View {
    private let model: NativeShellModel
    private let webContent: (_ hidden: Bool) -> WebContent
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var connectivity = PortfolioConnectivity()
    @State private var overlayFocusReturn = NativeOverlayFocusReturnCoordinator()
    /// The landing point at the top of a native screen (`<main>` for the skip link).
    @FocusState private var contentFocused: Bool
    /// The page-level scroll offset of the current native screen (the topbar's title).
    @State private var pageScroll: CGFloat = 0
    /// The titlebar strip the topbar occupies.
    @State private var titlebarHeight: CGFloat = 28
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: NativeShellModel, @ViewBuilder webContent: @escaping (_ hidden: Bool) -> WebContent) {
        self.model = model
        self.webContent = webContent
        _columnVisibility = State(initialValue: model.isSidebarVisible ? .all : .detailOnly)
    }

    private var isNativeDetail: Bool {
        if case .native = model.detail { return true }
        return false
    }

    /// Focus lands here from Skip to content, so the next Tab moves into the page.
    private var contentLanding: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .focusable()
            .focused($contentFocused)
            .focusEffectDisabled()
            .accessibilityHidden(true)
    }

    /// The detail column: banners, the web presentation and the native screen, the topbar.
    @ViewBuilder
    private func detailColumn(_ theme: VisionTheme) -> some View {
        VStack(spacing: 0) {
            shellBanners
            ZStack {
                NativeShellWebPresentation(mode: model.presentationMode, hidden: model.isWebContentHidden) {
                    webContent($0)
                }.ignoresSafeArea()
                if case .native(let screen) = model.detail {
                    NativePageZoomView(factor: model.pageZoom) {
                        NativeScreenContainer(screen: screen, model: model)
                            .overlay(alignment: .topLeading) { contentLanding }
                            .background { PageScrollObserver { pageScroll = $0 } }
                            .environment(\.colorScheme, theme.colorScheme)
                            // The mounted destination receives cold CSV/new-transaction intents.
                            .task(id: screen) { model.nativeIntentConsumerDidBecomeReady(for: screen) }
                    }
                } else if case .notFound = model.detail {
                    NativePageZoomView(factor: model.pageZoom) {
                        NativeNotFoundView(shell: model)
                            .environment(\.colorScheme, theme.colorScheme)
                    }
                } else if model.detail == .loading || model.detail == .unavailable {
                    unavailableView(theme)
                }
            }
            .overlay(alignment: .top) {
                if case .native = model.detail, let inspector = model.apiInspector {
                    BackgroundQueryIndicator(inspector: inspector)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { titlebarHeight = max($0, 28) }
        .overlay(alignment: .top) {
            if isNativeDetail {
                NativeTopbar(
                    model: model, height: titlebarHeight, scrolled: pageScroll > NativeTopbar.titleThreshold
                )
                .ignoresSafeArea(.container, edges: .top)
            }
        }
        .onChange(of: model.route.path) { pageScroll = 0 }
    }

    private func unavailableView(_ theme: VisionTheme) -> some View {
        let retry: (() -> Void)? = model.canRetryInitialSettings ? { model.reloadSettings() } : nil
        let reload: (@MainActor () -> Void)? = model.detail == .unavailable ? model.reloadPage : nil
        return NativeShellUnavailableView(detail: model.detail, strings: model.strings, retry: retry, reload: reload)
            .environment(\.colorScheme, theme.colorScheme)
    }

    public var body: some View {
        let theme = VisionTheme(selection: model.theme)
        NavigationSplitView(columnVisibility: $columnVisibility) {
            NativeSidebar(model: model, skipToContent: isNativeDetail ? { contentFocused = true } : nil)
                .navigationSplitViewColumnWidth(min: 200, ideal: 248, max: 340)
                .environment(\.colorScheme, theme.colorScheme)
                // The window has no toolbar (the page draws its topbar under the traffic
                // lights); NativeTopbar, View › Toggle Sidebar and ⌃⌘S toggle the sidebar instead.
                .toolbar(removing: .sidebarToggle)
        } detail: {
            detailColumn(theme)
        }
        .environment(\.visionTheme, theme)
        .environment(\.visionVisualEffects, model.nativeSettings?.effectiveVisualEffects ?? "standard")
        .environment(\.visionWealthCanvasTint, model.route.path.hasPrefix("/portfolio"))
        .environment(\.visionStaticAtmosphere, model.nativeSettings?.isLargeDisplay ?? false)
        .environment(\.locale, Locale(identifier: model.strings.language.rawValue))
        .environment(\.nativeNoticeCenter, model.notices)
        .overlay(alignment: .bottomTrailing) {
            if model.settings.adminMode, let inspector = model.apiInspector {
                NativeAPIInspectorOverlay(model: inspector).environment(\.visionTheme, theme)
            }
        }
        .overlay(alignment: .bottom) {
            if !model.isPresentingNativeOverlay {
                NativeNoticeHost(
                    center: model.notices, strings: model.strings, isWebVisible: model.detail == .web,
                    isEditingWebText: model.isEditingWebText
                )
                .environment(\.visionTheme, theme)
            }
        }
        .background {
            NativeOverlayFocusReturnBridge(
                owner: overlayFocusReturn, context: NativeOverlayFocusContext(shell: model),
                isPresented: model.isPresentingNativeOverlay
            ).frame(width: 0, height: 0)
        }
        .sheet(
            isPresented: Binding(
                get: { model.isPresentingNativeOverlay },
                set: { if !$0 { Task { await model.closeNativeOverlay() } } }
            ),
            onDismiss: {
                overlayFocusReturn.didDismiss(
                    context: NativeOverlayFocusContext(shell: model), isPresented: model.isPresentingNativeOverlay)
            }
        ) {
            NativeShellOverlayHost(shell: model)
                .environment(\.visionTheme, theme)
                .environment(\.visionVisualEffects, model.nativeSettings?.effectiveVisualEffects ?? "standard")
                .environment(\.colorScheme, theme.colorScheme)
                .environment(\.locale, Locale(identifier: model.strings.language.rawValue))
        }
        .overlay(alignment: .bottom) {
            if let review = model.portfolioImports?.review {
                PortfolioImportSuccessToast(model: review, shell: model)
                    .environment(\.visionTheme, theme)
            }
        }
        // `UnsavedChangesProvider`'s Leave this page? alert. The buttons decide; the binding
        // only reads, so a dismissal never drops the held navigation by itself.
        .alert(
            model.strings.t("unsavedChanges.title"),
            isPresented: Binding(get: { model.leaveConfirmation != nil }, set: { _ in })
        ) {
            Button(model.strings.t("unsavedChanges.stay"), role: .cancel) { model.stayOnPage() }
            Button(model.strings.t("unsavedChanges.leave"), role: .destructive) { model.leavePage() }
        } message: {
            Text(model.strings.t("unsavedChanges.description"))
        }
        .onChange(of: model.isSidebarVisible) { _, visible in
            let target: NavigationSplitViewVisibility = visible ? .all : .detailOnly
            if columnVisibility != target {
                withAnimation(reduceMotion ? nil : .easeInOut(duration: DesignTokens.Duration.normal)) {
                    columnVisibility = target
                }
            }
        }
        .onChange(of: columnVisibility) { _, visibility in
            let visible = visibility != .detailOnly
            model.setSidebarVisible(visible)
        }
        .onAppear {
            model.settingsAI?.isForeground = scenePhase == .active
            connectivity.start { online in
                let reconnecting = online && model.shellNotifications?.isOnline == false
                model.nativeSettings?.isOnline = online
                model.settingsAI?.isOnline = online
                model.onboarding?.isOnline = online
                model.shellNotifications?.isOnline = online
                if reconnecting, model.isRendererReady, !model.isReloadingGraph,
                    model.nativeSettings?.isSuspendedForRestore != true
                {
                    Task {
                        await model.shellNotifications?.refreshIfStale()
                        if model.onboarding?.isPresented == true { await model.onboarding?.loadAdapters() }
                    }
                }
            }
        }
        .task(id: startupIdentity) {
            guard model.isRendererReady, !model.isReloadingGraph,
                model.nativeSettings?.isSuspendedForRestore != true
            else { return }
            async let notifications: Void = loadNotifications()
            async let onboarding: Void = loadOnboarding()
            _ = await (notifications, onboarding)
        }
        .onChange(of: model.settings.language) { _, _ in model.onboarding?.strings = model.strings }
        .onChange(of: scenePhase) { _, phase in model.settingsAI?.isForeground = phase == .active }
        .onDisappear { connectivity.stop() }
        .disabled(model.isReloadingGraph)
        .allowsHitTesting(!model.isReloadingGraph)
    }
    @ViewBuilder private var shellBanners: some View {
        if let notifications = model.shellNotifications {
            if notifications.fx.shouldShow {
                ShellFXStatusBanner(model: notifications.fx, shell: model)
                    .padding(.horizontal, 20).padding(.top, 12)
            }
            if case .native(.home) = model.detail, notifications.upcoming.shouldShow {
                ShellUpcomingPaymentsBanner(model: notifications.upcoming, shell: model)
                    .padding(.horizontal, 20).padding(.top, 12)
            }
        }
    }
    private var startupIdentity: String {
        "\(ObjectIdentifier(model))|\(model.isRendererReady)|\(model.isReloadingGraph)|\(model.nativeSettings?.isSuspendedForRestore == true)"
    }
    private func loadNotifications() async { await model.shellNotifications?.load() }
    private func loadOnboarding() async {
        model.onboarding?.strings = model.strings
        await model.onboarding?.load()
    }
}

/// `AppSidebar`: the sections (admin in admin mode), collapsible section headers, and the
/// footer entries with Settings, as a source list on the web sidebar's glass chrome with its
/// emerald pill for the active page instead of the system selection highlight.
struct NativeSidebar: View {
    let model: NativeShellModel
    /// AppLayout's skip link; `nil` while no native screen is shown.
    var skipToContent: (() -> Void)?
    @Environment(\.visionTheme) private var theme
    @FocusState private var skipFocused: Bool

    var body: some View {
        List(selection: selection) {
            ForEach(model.sections) { section in
                sectionView(section)
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)
        // The pill marks the active row; a clear tint hides the system selection highlight
        // while keeping the list's selection and arrow-key movement.
        .tint(Color.clear)
        .accessibilityLabel(model.strings.t("nav.primary"))
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(alignment: .leading, spacing: 6) {
                brandButton
                HStack(spacing: 4) {
                    if model.commandPalette != nil { searchField } else { Spacer() }
                    collapseButton
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 6)
            .padding(.bottom, 4)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
        .overlay(alignment: .top) { skipLink }
        .overlay(alignment: .top) {
            // The titlebar strip over the sidebar drags the window; the traffic lights sit
            // above it in the window's own titlebar view.
            WindowDragArea().frame(height: 28).ignoresSafeArea(.container, edges: .top)
        }
        .background(SidebarGlassBackground())
        // The counts' own refetch policies run for the sidebar's lifetime; a route change
        // re-reads any count that is no longer fresh.
        .task { await model.sidebarBadges?.run() }
        .task(id: model.route.path) { await model.sidebarBadges?.refresh() }
    }

    /// Selecting a row (click or arrow keys) navigates; the selection follows the reported
    /// route, so a navigation the page has not confirmed yet does not move it.
    private var selection: Binding<String?> {
        Binding(
            get: { model.selectedItemURL },
            set: { url in
                if let url, url != model.route.path { model.navigate(to: url) }
            })
    }

    @ViewBuilder
    private func sectionView(_ section: NavSection) -> some View {
        if let labelKey = section.labelKey, section.collapsible {
            Section(isExpanded: expanded(section)) {
                rows(section.items)
            } header: {
                Text(model.strings.t(labelKey))
            }
        } else if let labelKey = section.labelKey {
            Section {
                rows(section.items)
            } header: {
                Text(model.strings.t(labelKey))
            }
        } else {
            Section {
                rows(section.items)
            }
        }
    }

    private func expanded(_ section: NavSection) -> Binding<Bool> {
        Binding(
            get: { model.isSectionExpanded(section) },
            set: { model.setSection(section.id, expanded: $0) })
    }

    /// The pill follows the route the page reports.
    private func rows(_ items: [NavItem]) -> some View {
        ForEach(items) { item in
            let isActive = model.selectedItemURL == item.url
            Label {
                Text(model.strings.t(item.titleKey))
                    .fontWeight(isActive ? .semibold : .regular)
                    .foregroundStyle(Color(token: theme.glass.foreground))
            } icon: {
                Image(systemName: item.symbol)
                    .foregroundStyle(Color(token: theme.glass.icon))
            }
            .tag(item.url as String?)
            // The web row's hover hint and rail tooltip, "<title> · G X".
            .help(
                item.shortcutKey.map { model.strings.t(item.titleKey) + " · G " + $0.uppercased() }
                    ?? model.strings.t(item.titleKey))
            .badge(badgeText(item))
            .badgeProminence(item.badge == .needsCategory || item.badge == .plannedDue ? .increased : .standard)
            .accessibilityValue(badgeLabel(item))
            .listRowBackground(SidebarSelectionPill(isActive: isActive))
        }
    }

    /// `NavItemBadge`: hidden at zero, capped at 99+; "hot" counts use increased prominence.
    private func badgeText(_ item: NavItem) -> Text? {
        guard let badge = item.badge else { return nil }
        let count = model.badgeCount(badge)
        guard count > 0 else { return nil }
        return Text(count > 99 ? "99+" : String(count))
    }

    private func badgeLabel(_ item: NavItem) -> String {
        guard let badge = item.badge else { return "" }
        let count = model.badgeCount(badge)
        guard count > 0 else { return "" }
        let key =
            switch badge {
            case .needsCategory: "nav.needsCategoryCount"
            case .plannedDue: "nav.plannedDueCount"
            case .insights: "nav.insightsCount"
            case .monitors: "monitors.unreadCount"
            }
        return model.strings.t(key, ["count": String(count)])
    }

    /// `layout.skipToContent`: first in keyboard order and shown only while focused, as the
    /// web's `sr-only focus:not-sr-only` link; it moves focus to the page content.
    @ViewBuilder
    private var skipLink: some View {
        if let skipToContent {
            Button(model.strings.t("layout.skipToContent"), action: skipToContent)
                .buttonStyle(.borderedProminent)
                .focused($skipFocused)
                .opacity(skipFocused ? 1 : 0)
                // Invisible, it must not take clicks meant for the search field below.
                .allowsHitTesting(skipFocused)
                .padding(.top, 6)
        }
    }

    /// AppSidebar's search field: opens the command palette (⌘K).
    private var searchField: some View {
        Button {
            model.openPalette()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass")
                Text(model.strings.t("commandPalette.hint"))
                Spacer(minLength: 4)
                Text("⌘K").font(.caption).foregroundStyle(.tertiary)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: DesignTokens.Radius.chip).fill(.quaternary))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(model.strings.t("commandPalette.openLabel"))
    }

    /// AppSidebar's Vision logo button (`aria.toggleSidebar`): the app's icon and name; a
    /// click toggles the sidebar like the web logo does.
    private var brandButton: some View {
        Button {
            model.toggleSidebar()
        } label: {
            HStack(spacing: 7) {
                Image(nsImage: NSApplication.shared.applicationIconImage)
                    .resizable()
                    .frame(width: 20, height: 20)
                    .accessibilityHidden(true)
                Text(verbatim: "Vision").font(.headline)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(model.strings.t("aria.toggleSidebar"))
        .accessibilityLabel(model.strings.t("aria.toggleSidebar"))
    }

    /// AppSidebar's header collapse button; ⌃⌘S and View › Toggle Sidebar bring it back.
    private var collapseButton: some View {
        Button {
            model.setSidebarVisible(false)
        } label: {
            Image(systemName: "sidebar.left")
                .foregroundStyle(.secondary)
                .frame(width: 24, height: 24)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(model.strings.t("aria.collapseSidebar"))
        .accessibilityLabel(model.strings.t("aria.collapseSidebar"))
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 2) {
            Divider().padding(.bottom, 4)
            ForEach(NavigationRegistry.footerItems) { item in
                footerButton(
                    title: model.strings.t(item.titleKey), symbol: item.symbol,
                    isActive: model.selectedItemURL == item.url
                ) {
                    model.navigate(to: item.url)
                }
            }
            footerButton(
                title: model.strings.t(NavigationRegistry.settingsTitleKey), symbol: NavigationRegistry.settingsSymbol,
                isActive: false
            ) {
                model.openSettings()
            }
        }
        .padding(.horizontal, 10)
        .padding(.bottom, 10)
    }

    private func footerButton(title: String, symbol: String, isActive: Bool, action: @escaping () -> Void)
        -> some View
    {
        Button(action: action) {
            Label(title, systemImage: symbol)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.vertical, 5)
                .padding(.horizontal, 8)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(
            RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                .fill(
                    isActive ? Color(token: theme.glass.selection, opacity: theme.glass.selectionOpacity) : Color.clear)
        )
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}

/// Hosts the native screen for a route and gives it the page's keyboard shortcuts.
struct NativeScreenContainer: View {
    let screen: NativeScreen
    let model: NativeShellModel
    @FocusState private var focused: Bool
    @Environment(\.visionTheme) private var theme

    var body: some View {
        content
            // PageTransition keys on the pathname; the canvas behind it stays put.
            .modifier(PageEntrance())
            .id(model.route.path)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(DetailGlassBackground())
            .focusable()
            .focusEffectDisabled()
            .focused($focused)
            .onKeyPress(phases: .down) { press in
                let modifiers = press.modifiers
                let handled = model.handleKey(
                    press.characters, command: modifiers.contains(.command), control: modifiers.contains(.control),
                    option: modifiers.contains(.option), shift: modifiers.contains(.shift))
                return handled ? .handled : .ignored
            }
            .onAppear { focused = true }
            // `ElectronBridge`'s window-level drop: a CSV dropped anywhere on a native screen
            // (outside the import dropzones, which take their own drops) goes to the import
            // page, pre-filled. Other files are ignored.
            .dropDestination(for: URL.self) { urls, _ in
                guard let url = urls.first, url.isFileURL, url.pathExtension.lowercased() == "csv" else { return false }
                Task {
                    guard let file = await ImportFile.read(url) else { return }
                    _ = model.openImportFile(file)
                }
                return true
            }
    }

    @ViewBuilder
    private var content: some View {
        switch screen {
        case .home:
            if let home = model.home { HomeView(model: home, shell: model) }
        case .statistics:
            if let statistics = model.statistics { StatisticsView(screens: statistics, shell: model) }
        case .tax:
            if let tax = model.tax { TaxOverviewView(screens: tax, shell: model) }
        case .portfolioTax:
            if let portfolio = model.portfolio, let tax = model.tax {
                PortfolioTaxView(model: portfolio.tax, tax: tax, shell: model, dataRevision: portfolio.dataRevision)
            }
        case .portfolioImport:
            if let imports = model.portfolioImports { PortfolioImportView(screens: imports, shell: model) }
        case .portfolioImportReview:
            if let imports = model.portfolioImports {
                PortfolioImportReviewView(model: imports.review, shell: model)
            }
        case .analysis:
            if let analysis = model.analysis {
                AnalysisWorkspaceView(model: analysis.workspace, workbench: analysis.workbench, shell: model)
            }
        case .analysisMonitors:
            if let monitors = model.analysisMonitors { AnalysisMonitorsView(model: monitors, shell: model) }
        case .researchHome, .researchMarkets, .researchMarketLookup, .researchWatchlist, .researchCompare:
            if let research = model.research {
                ResearchScreenView(screens: research, shell: model, screen: screen).id(screen.path)
            }
        case .researchForecast:
            if let forecast = model.researchForecast { ResearchForecastScreenView(screens: forecast, shell: model) }
        case .researchChartBuilder:
            if let charts = model.researchChartBuilder { ResearchChartBuilderScreenView(model: charts, shell: model) }
        case .researchDossiers:
            if let dossiers = model.researchDossiers { ResearchDossiersScreenView(model: dossiers, shell: model) }
        case .aiChat:
            if let aiChat = model.aiChat { AIChatScreenView(screens: aiChat, shell: model) }
        case .portfolio:
            if let portfolio = model.portfolio { PortfolioScreenView(screens: portfolio, shell: model) }
        case .portfolioHoldings(let assetClass):
            if let portfolio = model.portfolio {
                PortfolioScreenView(screens: portfolio, shell: model, assetClass: assetClass)
            }
        case .rebalance:
            if let portfolio = model.portfolio {
                RebalanceView(model: portfolio.rebalance, shell: model)
                    .task(id: portfolio.dataRevision) {
                        await portfolio.rebalance.load(route: model.route, settings: model.settings)
                    }
            }
        case .netWorth:
            if let portfolio = model.portfolio {
                NetWorthView(model: portfolio.netWorth, shell: model)
                    .task(id: portfolio.dataRevision) {
                        await portfolio.netWorth.load(
                            currency: model.settings.defaultCurrency, pageSize: model.settings.defaultPageSize,
                            route: model.route)
                    }
            }
        case .adminOverview:
            AdminOverviewView(model: model.admin.overview, shell: model)
        case .databaseMaintenance:
            DatabaseMaintenanceView(model: model.admin.database.maintenance, shell: model)
        case .tableEditor(let table):
            // The shell opens the table's editor when the route reports it.
            if let editor = model.admin.database.editor, editor.table == table {
                TableDataEditorView(model: editor, shell: model)
                    .id(table)
            }
        case .providerHealth:
            ProviderHealthView(model: model.admin.providers, shell: model)
        case .endpointLiveness:
            EndpointLivenessView(model: model.admin.endpoints, shell: model)
        case .exchangeRates:
            ExchangeRatesView(model: model.exchangeRates, shell: model)
        case .plannedPayments:
            PlannedPaymentsView(model: model.planned, shell: model)
        case .importExport:
            ImportExportView(model: model.imports, shell: model)
        case .importReview(let batchId):
            ImportReviewView(model: model.imports.review, toasts: model.imports.toasts, batchId: batchId, shell: model)
        case .transactions:
            TransactionsView(model: model.transactions, shell: model)
        case .owes:
            OwesView(model: model.owes, shell: model)
        case .accounts:
            AccountsView(model: model.accounts, shell: model)
        case .accountDetail(let id):
            AccountDetailView(model: model.accounts, shell: model, accountId: id)
                .id(id)
        case .categories:
            CategoriesView(model: model.categories, shell: model)
        case .recipients:
            RecipientsView(model: model.recipients, shell: model)
        }
    }
}
