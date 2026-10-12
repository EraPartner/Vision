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

/// `AppSidebar` as a source list: the sections (admin in admin mode), collapsible section
/// headers, and the footer entries with Settings.
struct NativeSidebar: View {
    let model: NativeShellModel

    var body: some View {
        List(selection: selection) {
            ForEach(model.sections) { section in
                sectionView(section)
            }
        }
        .listStyle(.sidebar)
        .accessibilityLabel(model.strings.t("nav.primary"))
        .safeAreaInset(edge: .bottom, spacing: 0) {
            footer
        }
    }

    /// Selecting a row navigates; the highlight follows the reported route.
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

    private func rows(_ items: [NavItem]) -> some View {
        ForEach(items) { item in
            Label(model.strings.t(item.titleKey), systemImage: item.symbol)
                .tag(item.url as String?)
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
                .fill(isActive ? Color.primary.opacity(0.08) : Color.clear))
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
            .background(theme.background)
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
    }

    @ViewBuilder
    private var content: some View {
        switch screen {
        case .exchangeRates:
            ExchangeRatesView(model: model.exchangeRates, shell: model)
        }
    }
}
