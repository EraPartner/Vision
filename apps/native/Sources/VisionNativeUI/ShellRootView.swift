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

    public init(model: NativeShellModel, @ViewBuilder webContent: @escaping (_ hidden: Bool) -> WebContent) {
        self.model = model
        self.webContent = webContent
    }

    public var body: some View {
        let theme = VisionTheme(selection: model.theme)
        NavigationSplitView(columnVisibility: $columnVisibility) {
            NativeSidebar(model: model)
                .navigationSplitViewColumnWidth(min: 200, ideal: 248, max: 340)
                .environment(\.colorScheme, theme.colorScheme)
                // The window has no toolbar (the page draws its topbar under the traffic
                // lights); View › Toggle Sidebar and ⌃⌘S toggle the sidebar instead.
                .toolbar(removing: .sidebarToggle)
        } detail: {
            ZStack {
                webContent(model.detail != .web)
                    .ignoresSafeArea()
                if case .native(let screen) = model.detail {
                    NativeScreenContainer(screen: screen, model: model)
                        .environment(\.colorScheme, theme.colorScheme)
                }
            }
        }
        .environment(\.visionTheme, theme)
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
                withAnimation(.easeInOut(duration: DesignTokens.Duration.normal)) { columnVisibility = target }
            }
        }
        .onChange(of: columnVisibility) { _, visibility in
            let visible = visibility != .detailOnly
            model.setSidebarVisible(visible)
        }
    }
}

/// `AppSidebar`: the sections (admin in admin mode), collapsible section headers, and the
/// footer entries with Settings, as a source list on the web sidebar's glass chrome with its
/// emerald pill for the active page instead of the system selection highlight.
struct NativeSidebar: View {
    let model: NativeShellModel
    @Environment(\.visionTheme) private var theme

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
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
        .background(SidebarGlassBackground())
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
            .listRowBackground(SidebarSelectionPill(isActive: isActive))
        }
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
                .fill(isActive ? Color(token: theme.glass.selection, opacity: theme.glass.selectionOpacity) : Color.clear))
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
        }
    }
}
