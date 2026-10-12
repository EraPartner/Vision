import Foundation
import Observation

/// What the detail column shows for the current route.
public enum NativeShellDetail: Equatable, Sendable {
    /// The web app, already at the route.
    case web
    case native(NativeScreen)
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
    /// `false` until `app_settings` has been read once; admin screens wait for it.
    public private(set) var settingsLoaded = false
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
    /// `/admin`, `/admin/providers` and `/admin/endpoints`.
    public let admin: AdminScreens

    @ObservationIgnored private let loadSettings: @Sendable () async throws -> NativeAppSettings
    @ObservationIgnored private let saveHiddenSections: @MainActor ([NavSectionID: Bool]) -> Void
    @ObservationIgnored private let onNavigate: @MainActor (MenuAction) -> Void
    @ObservationIgnored private let onSidebarVisibilityChange: @MainActor (Bool) -> Void
    @ObservationIgnored private var settingsTask: Task<Void, Never>?
    @ObservationIgnored private var delayedSettingsTask: Task<Void, Never>?
    @ObservationIgnored private let settingsReloadDelay: Duration
    @ObservationIgnored private var shortcuts = NativeShortcuts()

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
        self.hiddenSections = hiddenSections ?? Self.defaultHiddenSections
        self.loadSettings = loadSettings
        self.saveHiddenSections = saveHiddenSections
        self.onNavigate = onNavigate
        self.onSidebarVisibilityChange = onSidebarVisibilityChange
        self.settingsReloadDelay = settingsReloadDelay
    }

    /// `DEFAULT_HIDDEN` of useSidebarPreferences.
    public static var defaultHiddenSections: [NavSectionID: Bool] {
        var hidden: [NavSectionID: Bool] = [:]
        for section in NavigationRegistry.sections where section.defaultHidden { hidden[section.id] = true }
        return hidden
    }

    // MARK: Route

    /// The native screen for the route, or the web app. An admin screen is shown only
    /// once `app_settings` says admin mode is on; otherwise the page shows the route and
    /// its `RequireAdmin` redirects, which the page then reports.
    public var detail: NativeShellDetail {
        guard !isPresentingWeb, let screen = NativeScreen.screen(forPath: route.path) else { return .web }
        if screen.requiresAdmin && !(settingsLoaded && settings.adminMode) { return .web }
        return .native(screen)
    }

    public var sections: [NavSection] {
        NavigationRegistry.visibleSections(adminMode: settings.adminMode)
    }

    /// The URL of the sidebar row to highlight.
    public var selectedItemURL: String? {
        NavigationRegistry.matchItem(path: route.path)?.url
    }

    /// `shell:route-changed`: the page's router moved, or an overlay closed on the same route.
    public func routeDidChange(_ next: NativeRoute) {
        let pathChanged = next.path != route.path
        let settingsClosed = route.value("settings") != nil && next.value("settings") == nil
        // A new page, the settings dialog closing (`?settings` removed), or the same route
        // again (the palette or shortcuts overlay closed) ends a web presentation over a
        // native screen.
        if pathChanged || settingsClosed || next == route { isPresentingWeb = false }
        pendingRoute = nil
        route = next
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
    }

    /// A sidebar click or another native link. The page moves (or keeps its route behind an
    /// unsaved-changes prompt) and reports the result; until then the route stays.
    public func navigate(to url: String) {
        guard let next = NativeRoute(url) else { return }
        pendingRoute = next
        onNavigate(.navigate(next.string))
    }

    /// `setSearchParams(..., { replace: true })` for the current route.
    public func replaceQuery(_ name: String, with value: String) {
        let next = route.setting(name, to: value)
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
        settings = next
        settingsLoaded = true
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
