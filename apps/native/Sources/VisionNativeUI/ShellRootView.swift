import AppKit
import SwiftUI
import VisionNativeCore

/// The window content of Vision Native: a native sidebar built from `NavigationRegistry`, and
/// a detail column that shows the native screen of the current route.
public struct ShellRootView: View {
    private let model: NativeShellModel
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    @State private var connectivity = PortfolioConnectivity()
    @State private var overlayFocusReturn = NativeOverlayFocusReturnCoordinator()
    /// The overlay shown last, so the dialog keeps its geometry while it animates out.
    @State private var lastOverlayKind: NativeShellOverlayKind?
    /// The landing point at the top of a native screen (`<main>` for the skip link).
    @FocusState private var contentFocused: Bool
    /// Whether the current native screen has scrolled past the topbar title threshold. Only
    /// the crossing is stored: a per-pixel offset here would re-run the whole shell body (and
    /// re-diff the sidebar) on every scroll tick and every resize frame of the sidebar animation.
    @State private var pageScrolled = false
    /// The titlebar strip the topbar occupies.
    @State private var titlebarHeight: CGFloat = 28
    /// The titlebar safe area the detail column really receives (zero when the window has no
    /// toolbar), so the topbar clearance only adds what the system does not already reserve.
    @State private var titlebarSafeInset: CGFloat = 0
    /// The native page's width while the sidebar animates in or out (see `FrozenWidthLayout`).
    @State private var frozenDetailWidth: CGFloat?
    /// The last settled column widths, the frozen width's sources. A plain reference, so the
    /// per-frame writes of a window resize never invalidate the shell body.
    @State private var columnWidths = ShellColumnWidths()
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    public init(model: NativeShellModel) {
        self.model = model
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

    /// The detail column: while the sidebar is collapsed, the icon rail (`AppSidebar`
    /// `collapsible="icon"`) beside the page; the page itself is `pageColumn`.
    @ViewBuilder
    private func detailColumn(_ theme: VisionTheme) -> some View {
        HStack(spacing: 0) {
            if !model.isSidebarVisible {
                NativeSidebarRail(model: model, topInset: max(0, 28 - titlebarSafeInset))
                    .environment(\.colorScheme, theme.colorScheme)
            }
            pageColumn(theme)
        }
    }

    /// The banners, the native screen and the topbar.
    @ViewBuilder
    private func pageColumn(_ theme: VisionTheme) -> some View {
        VStack(spacing: 0) {
            // Native pages take the banners as a top inset so the page canvas runs behind them
            // and under the titlebar strip; the other states stack them above.
            if !isNativeDetail { shellBanners }
            ZStack {
                if case .native(let screen) = model.detail {
                    FrozenWidthLayout(width: frozenDetailWidth) {
                        NativePageZoomView(factor: model.pageZoom) {
                            NativeScreenContainer(screen: screen, model: model)
                                .safeAreaInset(edge: .top, spacing: 0) {
                                    VStack(spacing: 0) {
                                        // The web topbar (`h-14`) is in flow above `<main>`: the page starts
                                        // below it, so titles and banners clear the traffic lights and the
                                        // sidebar and search buttons drawn in the titlebar strip.
                                        Color.clear.frame(height: max(0, NativeTopbar.barHeight - titlebarSafeInset))
                                        shellBanners
                                    }
                                }
                                .overlay(alignment: .topLeading) { contentLanding }
                                .background { PageScrollObserver { pageScrollDidChange($0) } }
                                .environment(\.colorScheme, theme.colorScheme)
                                // The mounted destination receives cold CSV/new-transaction intents.
                                .task(id: screen) { model.nativeIntentConsumerDidBecomeReady(for: screen) }
                        }
                    }
                    // Clip the page to its column sideways only: the canvas still runs up under
                    // the titlebar strip.
                    .mask { Rectangle().padding(.vertical, -400) }
                } else if case .notFound = model.detail {
                    NativePageZoomView(factor: model.pageZoom) {
                        NativeNotFoundView(shell: model)
                            .environment(\.colorScheme, theme.colorScheme)
                    }
                } else if model.detail == .loading || model.detail == .unavailable {
                    unavailableView(theme)
                }
            }
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                // Only settled widths: mid-slide widths would make the next freeze wrong.
                if frozenDetailWidth == nil { columnWidths.detail = width }
            }
            .overlay(alignment: .top) {
                if case .native = model.detail, let inspector = model.apiInspector {
                    BackgroundQueryIndicator(inspector: inspector)
                }
            }
        }
        .onGeometryChange(for: CGFloat.self) { $0.safeAreaInsets.top } action: { inset in
            titlebarSafeInset = inset
            titlebarHeight = max(inset, 28)
        }
        .overlay(alignment: .top) {
            if isNativeDetail {
                NativeTopbar(model: model, height: titlebarHeight, scrolled: pageScrolled)
                    .ignoresSafeArea(.container, edges: .top)
            }
        }
        .onChange(of: model.route.path) { pageScrolled = false }
    }

    /// Holds the native page at one width while the sidebar column slides: AppKit resizes the
    /// detail column every frame, and every chart, table and geometry reader on the page
    /// re-laid out with it. Closing lays the page out at its final width at once (revealed as
    /// the sidebar leaves); opening keeps the current width until the slide ends, then reflows once.
    private func freezeDetailForSidebarAnimation(opening: Bool) {
        let widths = columnWidths
        guard !reduceMotion, isNativeDetail, widths.detail > 0 else { return }
        // The rail takes its width from the page when the sidebar closes.
        frozenDetailWidth = opening ? widths.detail : widths.detail + widths.sidebar - NativeSidebarRail.width
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(DesignTokens.Duration.normal + 0.12))
            frozenDetailWidth = nil
        }
    }

    private func pageScrollDidChange(_ offset: CGFloat) {
        let scrolled = offset > NativeTopbar.titleThreshold
        if scrolled != pageScrolled { pageScrolled = scrolled }
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
                .navigationSplitViewColumnWidth(
                    min: SidebarWidthGuard.minimumWidth, ideal: SidebarWidthGuard.idealWidth,
                    max: SidebarWidthGuard.maximumWidth)
                .environment(\.colorScheme, theme.colorScheme)
                .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { width in
                    if frozenDetailWidth == nil, width > 0 { columnWidths.sidebar = width }
                }
                // The window has no toolbar (the page draws its topbar under the traffic
                // lights); NativeTopbar, View › Toggle Sidebar and ⌃⌘S toggle the sidebar instead.
                .toolbar(removing: .sidebarToggle)
        } detail: {
            detailColumn(theme)
        }
        .environment(\.visionTheme, theme)
        .background { WindowAppearanceSync(isDark: theme.isDark) }
        // Prominent buttons, toggles and pickers take the web's emerald `--primary` (or the
        // chosen accent) instead of the system blue.
        .tint(theme.primary)
        .environment(\.visionVisualEffects, model.nativeSettings?.effectiveVisualEffects ?? .standard)
        .environment(\.visionFullEffects, model.nativeSettings?.fullEffects ?? false)
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
                NativeNoticeHost(center: model.notices, strings: model.strings)
                .environment(\.visionTheme, theme)
            }
        }
        .background {
            NativeOverlayFocusReturnBridge(
                owner: overlayFocusReturn, context: NativeOverlayFocusContext(shell: model),
                isPresented: model.isPresentingNativeOverlay
            ).frame(width: 0, height: 0)
        }
        .visionDialog(
            isPresented: Binding(
                get: { model.isPresentingNativeOverlay },
                set: { if !$0 { Task { await model.closeNativeOverlay() } } }
            ),
            metrics: NativeShellOverlayHost.metrics(for: model.nativeOverlayKind ?? lastOverlayKind),
            accessibilityTitle: NativeShellOverlayHost.accessibilityTitle(
                for: model.nativeOverlayKind ?? lastOverlayKind, strings: model.strings),
            onDismiss: {
                overlayFocusReturn.didDismiss(
                    context: NativeOverlayFocusContext(shell: model), isPresented: model.isPresentingNativeOverlay)
            }
        ) {
            NativeShellOverlayHost(shell: model)
                .environment(\.visionTheme, theme)
                .environment(\.colorScheme, theme.colorScheme)
                .environment(\.locale, Locale(identifier: model.strings.language.rawValue))
        }
        .onChange(of: model.nativeOverlayKind) { _, kind in if let kind { lastOverlayKind = kind } }
        .overlay(alignment: .bottom) {
            if let review = model.portfolioImports?.review {
                PortfolioImportSuccessToast(model: review, shell: model)
                    .environment(\.visionTheme, theme)
            }
        }
        // `UnsavedChangesProvider`'s Leave this page? alert. The buttons decide; the binding
        // only reads, so a dismissal never drops the held navigation by itself.
        .visionAlert(
            title: model.strings.t("unsavedChanges.title"),
            message: model.strings.t("unsavedChanges.description"),
            isPresented: Binding(get: { model.leaveConfirmation != nil }, set: { _ in })
        ) {
            VisionDialogAction(model.strings.t("unsavedChanges.stay"), role: .cancel) { model.stayOnPage() }
            VisionDialogAction(model.strings.t("unsavedChanges.leave"), role: .destructive) { model.leavePage() }
        }
        .onChange(of: model.isSidebarVisible) { _, visible in
            let target: NavigationSplitViewVisibility = visible ? .all : .detailOnly
            if columnVisibility != target {
                freezeDetailForSidebarAnimation(opening: visible)
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
                if reconnecting, model.nativeDocumentState == .ready, !model.isReloadingGraph,
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
            guard model.nativeDocumentState == .ready, !model.isReloadingGraph,
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
        // Outermost, so the chrome the dialog and alert modifiers add (scrim, glass panel and
        // their materials) resolves in the app theme and effects rather than the defaults and
        // the system appearance: those modifiers sit outside the environment set above.
        .environment(\.visionTheme, theme)
        .environment(\.visionVisualEffects, model.nativeSettings?.effectiveVisualEffects ?? .standard)
        .environment(\.visionFullEffects, model.nativeSettings?.fullEffects ?? false)
        .environment(\.colorScheme, theme.colorScheme)
    }
    private var shellBanners: some View {
        VStack(spacing: 0) { shellBannerStack }
    }
    @ViewBuilder private var shellBannerStack: some View {
        if let notifications = model.shellNotifications {
            if notifications.fx.shouldShow {
                ShellFXStatusBanner(model: notifications.fx, shell: model)
                    .padding(.horizontal, VisionPageLayout.padding).padding(.top, 12)
            }
            // The Home reminder banner lives inside HomeView's scroll content so it scrolls away
            // with the page, as `UpcomingPaymentsNotification` does in the web `<main>`.
        }
    }
    private var startupIdentity: String {
        "\(ObjectIdentifier(model))|\(model.nativeDocumentState == .ready)|\(model.isReloadingGraph)|\(model.nativeSettings?.isSuspendedForRestore == true)"
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
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.visionTheme) private var theme
    @FocusState private var skipFocused: Bool

    var body: some View {
        // The header and footer sit outside the list, as on the web, so scrolled rows clip at
        // the list's edges instead of showing through the translucent chrome.
        VStack(spacing: 0) {
            // AppSidebar's header: the logo, name and collapse button in one row, then the
            // full-width search field.
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 10) {
                    brandButton
                    collapseButton
                }
                .frame(height: 32)
                if model.commandPalette != nil { searchField }
            }
            .padding(.horizontal, 12)
            .padding(.top, 4)
            .padding(.bottom, 8)
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
        // It idles while the app is inactive or hidden (the web pauses refetch intervals while
        // the document is hidden) and re-reads whatever went stale when the app returns.
        .task(id: scenePhase == .active) {
            guard scenePhase == .active else { return }
            await model.sidebarBadges?.run()
        }
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
                HStack(spacing: 6) {
                    Text(model.strings.t(item.titleKey))
                        .fontWeight(isActive ? .semibold : .regular)
                        .foregroundStyle(Color(token: theme.glass.foreground))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    badgeView(item)
                }
            } icon: {
                Image(systemName: item.symbol)
                    .foregroundStyle(Color(token: theme.glass.icon))
            }
            .tag(item.url as String?)
            // The web row's hover hint and rail tooltip, "<title> · G X".
            .help(
                item.shortcutKey.map { model.strings.t(item.titleKey) + " · G " + $0.uppercased() }
                    ?? model.strings.t(item.titleKey))
            .accessibilityValue(badgeLabel(item))
            .listRowBackground(SidebarSelectionPill(isActive: isActive))
        }
    }

    /// `NavItemBadge`: hidden at zero, capped at 99+; "hot" counts are an 18 pt primary pill,
    /// quiet ones plain tertiary figures.
    @ViewBuilder
    private func badgeView(_ item: NavItem) -> some View {
        let count = item.badge.map { model.badgeCount($0) } ?? 0
        if count > 0 {
            let hot = item.badge == .needsCategory || item.badge == .plannedDue
            Text(count > 99 ? "99+" : String(count))
                .font(.caption.weight(hot ? .medium : .regular))
                .monospacedDigit()
                .foregroundStyle(hot ? theme.primaryForeground : theme.tertiaryLabel)
                .padding(.horizontal, 6)
                .frame(minWidth: 18, minHeight: 18)
                .background(Capsule().fill(hot ? theme.primary : Color.clear))
                .accessibilityHidden(true)
        }
    }

    private func badgeLabel(_ item: NavItem) -> String { model.sidebarBadgeLabel(item) }

    /// `layout.skipToContent`: first in keyboard order and shown only while focused, as the
    /// web's `sr-only focus:not-sr-only` link; it moves focus to the page content.
    @ViewBuilder
    private var skipLink: some View {
        if let skipToContent {
            Button(model.strings.t("layout.skipToContent"), action: skipToContent)
                .buttonStyle(.visionPrimary)
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
                // One line at any sidebar width: the hint truncates and the shortcut hides
                // before the text would wrap.
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 6) {
                        Text(model.strings.t("commandPalette.hint")).fixedSize()
                        Spacer(minLength: 4)
                        Text("⌘K").font(.caption).foregroundStyle(.tertiary).fixedSize()
                    }
                    Text(model.strings.t("commandPalette.hint")).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .font(.callout)
            .foregroundStyle(theme.tertiaryLabel)
            .padding(.horizontal, 10)
            .frame(height: 32)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.chip).fill(theme.foreground.opacity(0.06)))
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
            HStack(spacing: 10) {
                // The web logo: the Vision mark on a 28 pt primary-to-accent gradient chip.
                SidebarBrandChip()
                Text(verbatim: "Vision").font(.visionDisplayHeadline)
                    .foregroundStyle(Color(token: theme.glass.foreground))
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
                .foregroundStyle(theme.tertiaryLabel)
                .frame(width: 28, height: 28)
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
            .environment(\.visionContainerOwnsFocus, focused)
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
                    option: modifiers.contains(.option), shift: modifiers.contains(.shift),
                    // A focused TextField or TextEditor edits through an NSText field editor.
                    typing: NSApp.keyWindow?.firstResponder is NSText)
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

/// Lays its one subview out at `width` when set, pinned to the trailing edge, and otherwise
/// at the offered size. The same view type either way, so freezing never resets page state.
struct FrozenWidthLayout: Layout {
    var width: CGFloat?

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let subview = subviews.first else { return .zero }
        let fitted = subview.sizeThatFits(
            width.map { ProposedViewSize(width: $0, height: proposal.height) } ?? proposal)
        return CGSize(width: proposal.width ?? fitted.width, height: proposal.height ?? fitted.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let subview = subviews.first else { return }
        let laidOut = width ?? bounds.width
        subview.place(
            at: CGPoint(x: bounds.maxX - laidOut, y: bounds.minY), anchor: .topLeading,
            proposal: ProposedViewSize(width: laidOut, height: bounds.height))
    }
}

/// Column widths read by the sidebar freeze; deliberately not observable.
final class ShellColumnWidths {
    var detail: CGFloat = 0
    var sidebar: CGFloat = 0
}
