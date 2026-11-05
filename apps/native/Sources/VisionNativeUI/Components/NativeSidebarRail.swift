import SwiftUI
import VisionNativeCore

/// The Vision logo chip of `AppSidebar`'s header: the mark on a primary-to-accent gradient
/// square (`h-7 w-7`, 28 pt), shared by the expanded sidebar and the collapsed rail.
struct SidebarBrandChip: View {
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VisionBrandMark()
            .fill(theme.primaryForeground)
            .frame(width: 14, height: 14)
            .frame(width: 28, height: 28)
            .background(
                RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [theme.primary, theme.primary.opacity(0.85), theme.accent.opacity(0.7)],
                            startPoint: .topLeading, endPoint: .bottomTrailing))
            )
            .shadow(color: theme.primary.opacity(0.35), radius: 9, y: 6)
            .accessibilityHidden(true)
    }
}

extension NativeShellModel {
    /// The screen-reader value of a sidebar row's count ("3 need a category"); empty at zero.
    func sidebarBadgeLabel(_ item: NavItem) -> String {
        guard let badge = item.badge else { return "" }
        let count = badgeCount(badge)
        guard count > 0 else { return "" }
        let key =
            switch badge {
            case .needsCategory: "nav.needsCategoryCount"
            case .plannedDue: "nav.plannedDueCount"
            case .insights: "nav.insightsCount"
            case .monitors: "monitors.unreadCount"
            }
        return strings.t(key, ["count": String(count)])
    }
}

/// `AppSidebar` collapsed to its icon rail (`collapsible="icon"`, `--sidebar-width-icon` 3rem):
/// the logo button that expands the sidebar, the search button, one 32 pt icon button per
/// page with a "<title> · G X" tooltip and the active page's pill, a divider between
/// sections, and the footer pages and Settings. The count becomes a small pill on the icon.
struct NativeSidebarRail: View {
    /// `SIDEBAR_WIDTH_ICON` (3rem).
    static let width: CGFloat = 48
    /// `size-8` icon buttons.
    private static let buttonSize: CGFloat = 32

    let model: NativeShellModel
    /// Clearance below the traffic lights that the window's own safe area does not reserve.
    let topInset: CGFloat
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(spacing: 0) {
            header
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 2) {
                    ForEach(Array(model.sections.enumerated()), id: \.element.id) { index, section in
                        if index > 0 { Divider().padding(.horizontal, 4).padding(.vertical, 4) }
                        if model.isSectionExpanded(section) {
                            ForEach(section.items) { item in navButton(item) }
                        }
                    }
                }
                .padding(.vertical, 2)
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel(model.strings.t("nav.primary"))
            footer
        }
        .frame(width: Self.width)
        .frame(maxHeight: .infinity)
        .background { SidebarGlassBackground().ignoresSafeArea() }
        .overlay(alignment: .trailing) {
            Rectangle().fill(Color(token: theme.palette.sidebarBorder, opacity: 0.6)).frame(width: 1)
        }
        .overlay(alignment: .top) {
            // The titlebar strip over the rail drags the window, as over the sidebar.
            WindowDragArea().frame(height: 28).ignoresSafeArea(.container, edges: .top)
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(spacing: 8) {
            Button {
                model.toggleSidebar()
            } label: {
                SidebarBrandChip()
                    .frame(width: Self.buttonSize, height: Self.buttonSize)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(model.strings.t("aria.toggleSidebar"))
            .accessibilityLabel(model.strings.t("aria.toggleSidebar"))
            if model.commandPalette != nil {
                railButton(
                    symbol: "magnifyingglass", label: model.strings.t("commandPalette.openLabel"),
                    tooltip: model.strings.t("commandPalette.openLabel") + " · ⌘K", isActive: false
                ) {
                    model.openPalette()
                }
            }
        }
        .padding(.top, topInset + 8)
        .padding(.bottom, 8)
    }

    // MARK: Pages

    private func navButton(_ item: NavItem) -> some View {
        let title = model.strings.t(item.titleKey)
        let tooltip = item.shortcutKey.map { title + " · G " + $0.uppercased() } ?? title
        return railButton(
            symbol: item.symbol, label: title, tooltip: tooltip, isActive: model.selectedItemURL == item.url,
            badge: item.badge.map { model.badgeCount($0) } ?? 0, badgeLabel: model.sidebarBadgeLabel(item)
        ) {
            if item.url != model.route.path { model.navigate(to: item.url) }
        }
    }

    private var footer: some View {
        VStack(spacing: 2) {
            Divider().padding(.horizontal, 4).padding(.bottom, 4)
            ForEach(NavigationRegistry.footerItems) { item in
                let title = model.strings.t(item.titleKey)
                railButton(
                    symbol: item.symbol, label: title,
                    tooltip: item.shortcutKey.map { title + " · G " + $0.uppercased() } ?? title,
                    isActive: model.selectedItemURL == item.url
                ) {
                    model.navigate(to: item.url)
                }
            }
            let settings = model.strings.t(NavigationRegistry.settingsTitleKey)
            railButton(
                symbol: NavigationRegistry.settingsSymbol, label: settings, tooltip: settings + " · ⌘,",
                isActive: false
            ) {
                model.openSettings()
            }
        }
        .padding(.bottom, 10)
    }

    /// One 32 pt icon button: the glass selection pill when active, a count pill on its corner.
    private func railButton(
        symbol: String, label: String, tooltip: String, isActive: Bool, badge: Int = 0, badgeLabel: String = "",
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 15))
                .foregroundStyle(Color(token: theme.glass.icon))
                .frame(width: Self.buttonSize, height: Self.buttonSize)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip)
                        .fill(
                            isActive
                                ? Color(token: theme.glass.selection, opacity: theme.glass.selectionOpacity)
                                : Color.clear)
                )
                .overlay(alignment: .topTrailing) { countPill(badge) }
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(tooltip)
        .accessibilityLabel(label)
        .accessibilityValue(badgeLabel)
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }

    /// `SidebarCount` collapsed: `h-4 min-w-4` primary pill at `-right-1 -top-1`.
    @ViewBuilder
    private func countPill(_ count: Int) -> some View {
        if count > 0 {
            Text(count > 99 ? "99+" : String(count))
                .font(.system(size: 10, weight: .medium))
                .monospacedDigit()
                .foregroundStyle(theme.primaryForeground)
                .padding(.horizontal, 4)
                .frame(minWidth: 16, minHeight: 16)
                .background(Capsule().fill(theme.primary))
                .offset(x: 4, y: -4)
                .accessibilityHidden(true)
        }
    }
}
