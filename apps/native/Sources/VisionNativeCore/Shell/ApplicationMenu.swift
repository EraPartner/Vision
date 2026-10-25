import Foundation

/// A menu or dock action the native shell performs (Electron's `ElectronMenuAction`).
public struct MenuAction: Hashable, Sendable {
    public let action: String
    public let payload: String?

    public init(_ action: String, payload: String? = nil) {
        self.action = action
        self.payload = payload
    }

    public static let openSettings = MenuAction("open-settings")
    /// Native history decides Back versus query replacement when Settings closes.
    public static let closeSettings = MenuAction("close-settings")
    public static let openShortcuts = MenuAction("open-shortcuts")
    public static let newTransaction = MenuAction("new-transaction")
    public static let toggleSidebar = MenuAction("toggle-sidebar")
    /// Opens the command palette.
    public static let openPalette = MenuAction("open-palette")

    public static func navigate(_ path: String) -> MenuAction { MenuAction("navigate", payload: path) }
    public static func setTheme(_ mode: String) -> MenuAction { MenuAction("set-theme", payload: mode) }
}

/// What a menu item does. Shell actions go to the native owners (`NativeShellModel`); the
/// others are the Electron menu roles, performed by AppKit.
public enum MenuCommand: Hashable, Sendable {
    case action(MenuAction)
    case openExternal(String)
    case about
    case services
    case hide
    case hideOthers
    case showAll
    case quit
    case closeWindow
    case undo
    case redo
    case cut
    case copy
    case paste
    case selectAll
    case print
    case reload
    case resetZoom
    case zoomIn
    case zoomOut
    case toggleFullScreen
    case minimize
    case zoom
    case bringAllToFront
}

public struct KeyModifiers: OptionSet, Hashable, Sendable {
    public let rawValue: Int
    public init(rawValue: Int) { self.rawValue = rawValue }

    public static let command = KeyModifiers(rawValue: 1)
    public static let shift = KeyModifiers(rawValue: 2)
    public static let option = KeyModifiers(rawValue: 4)
    public static let control = KeyModifiers(rawValue: 8)
}

/// An AppKit key equivalent: a lowercase key plus modifiers.
public struct KeyEquivalent: Hashable, Sendable {
    public let key: String
    public let modifiers: KeyModifiers

    public init(_ key: String, _ modifiers: KeyModifiers = .command) {
        self.key = key
        self.modifiers = modifiers
    }
}

public struct MenuItemModel: Hashable, Sendable {
    public let title: String
    public let command: MenuCommand
    public let keyEquivalent: KeyEquivalent?
    /// A hidden item that only adds a second key equivalent for a visible one.
    public let isHidden: Bool

    public init(
        _ title: String, _ command: MenuCommand, _ keyEquivalent: KeyEquivalent? = nil, isHidden: Bool = false
    ) {
        self.title = title
        self.command = command
        self.keyEquivalent = keyEquivalent
        self.isHidden = isHidden
    }
}

public enum SubmenuRole: Hashable, Sendable {
    case plain
    case services
    case window
    case help
}

public indirect enum MenuEntry: Hashable, Sendable {
    case item(MenuItemModel)
    case separator
    case submenu(title: String, role: SubmenuRole, entries: [MenuEntry])
}

/// `setupApplicationMenu` and `setupDockMenu` in packaging/electron/main.ts for macOS. Items
/// that Electron labels with `t()` use the same keys; role items keep Electron's English
/// labels.
public enum ApplicationMenu {
    /// `GO_MENU_ROUTES`; mirrors `GO_TO_ROUTES` in apps/frontend/src/hooks/useGoToShortcuts.ts.
    public static let goRoutes: [(path: String, titleKey: String)] = [
        ("/", "nav.home"),
        ("/transactions", "nav.transactions"),
        ("/statistics", "nav.statistics"),
        ("/categories", "nav.categories"),
        ("/recipients", "nav.recipients"),
        ("/import", "nav.importExport"),
        ("/portfolio", "nav.portfolio"),
        ("/portfolio/net-worth", "nav.netWorth"),
        ("/ai-chat", "nav.aiChat"),
    ]

    /// `THEME_MENU_MODES`; the ids match `ThemeMode`.
    public static let themeModes: [(id: String, titleKey: String)] = [
        ("light", "layout.light"),
        ("dark", "layout.dark"),
        ("system", "layout.system"),
        ("schedule", "layout.schedule"),
    ]

    public static func build(appName: String, strings: ShellStrings) -> [MenuEntry] {
        let t = { (key: String) in strings.t(key) }
        let app: [MenuEntry] = [
            .item(MenuItemModel("About \(appName)", .about)),
            .separator,
            .item(MenuItemModel(t("menu.settings"), .action(.openSettings), KeyEquivalent(","))),
            .separator,
            .submenu(title: "Services", role: .services, entries: []),
            .separator,
            .item(MenuItemModel("Hide \(appName)", .hide, KeyEquivalent("h"))),
            .item(MenuItemModel("Hide Others", .hideOthers, KeyEquivalent("h", [.command, .option]))),
            .item(MenuItemModel("Show All", .showAll)),
            .separator,
            .item(MenuItemModel("Quit \(appName)", .quit, KeyEquivalent("q"))),
        ]
        let file: [MenuEntry] = [
            .item(MenuItemModel(t("menu.newTransaction"), .action(.newTransaction), KeyEquivalent("n"))),
            .item(
                MenuItemModel(
                    t("menu.importCsv"), .action(.navigate("/import")), KeyEquivalent("i", [.command, .shift]))),
            .separator,
            .item(MenuItemModel("Print…", .print, KeyEquivalent("p"))),
            .separator,
            .item(MenuItemModel("Close Window", .closeWindow, KeyEquivalent("w"))),
        ]
        let edit: [MenuEntry] = [
            .item(MenuItemModel("Undo", .undo, KeyEquivalent("z"))),
            .item(MenuItemModel("Redo", .redo, KeyEquivalent("z", [.command, .shift]))),
            .separator,
            .item(MenuItemModel("Cut", .cut, KeyEquivalent("x"))),
            .item(MenuItemModel("Copy", .copy, KeyEquivalent("c"))),
            .item(MenuItemModel("Paste", .paste, KeyEquivalent("v"))),
            .item(MenuItemModel("Select All", .selectAll, KeyEquivalent("a"))),
        ]
        let appearance: [MenuEntry] = themeModes.map { mode in
            .item(MenuItemModel(t(mode.titleKey), .action(.setTheme(mode.id))))
        }
        let view: [MenuEntry] = [
            .item(
                MenuItemModel(
                    t("menu.toggleSidebar"), .action(.toggleSidebar), KeyEquivalent("s", [.command, .control]))
            ),
            .submenu(title: t("menu.appearance"), role: .plain, entries: appearance),
            .separator,
            .item(MenuItemModel("Reload", .reload, KeyEquivalent("r"))),
            .separator,
            .item(MenuItemModel("Actual Size", .resetZoom, KeyEquivalent("0"))),
            .item(MenuItemModel("Zoom In", .zoomIn, KeyEquivalent("+"))),
            // Plain ⌘= on layouts where + needs Shift (Electron's zoomIn accepts both).
            .item(MenuItemModel("Zoom In", .zoomIn, KeyEquivalent("="), isHidden: true)),
            .item(MenuItemModel("Zoom Out", .zoomOut, KeyEquivalent("-"))),
            .separator,
            .item(MenuItemModel("Toggle Full Screen", .toggleFullScreen, KeyEquivalent("f", [.command, .control]))),
        ]
        let go: [MenuEntry] = goRoutes.enumerated().map { index, route in
            .item(MenuItemModel(t(route.titleKey), .action(.navigate(route.path)), KeyEquivalent("\(index + 1)")))
        }
        let window: [MenuEntry] = [
            .item(MenuItemModel("Minimize", .minimize, KeyEquivalent("m"))),
            .item(MenuItemModel("Zoom", .zoom)),
            .separator,
            .item(MenuItemModel("Bring All to Front", .bringAllToFront)),
        ]
        let help: [MenuEntry] = [
            .item(MenuItemModel(t("menu.keyboardShortcuts"), .action(.openShortcuts))),
            .separator,
            .item(MenuItemModel(t("menu.sourceCode"), .openExternal(ShellLinks.repository))),
            .item(MenuItemModel(t("menu.documentation"), .openExternal(ShellLinks.documentation))),
        ]
        return [
            .submenu(title: appName, role: .plain, entries: app),
            .submenu(title: t("menu.file"), role: .plain, entries: file),
            .submenu(title: t("menu.edit"), role: .plain, entries: edit),
            .submenu(title: t("menu.view"), role: .plain, entries: view),
            .submenu(title: t("menu.go"), role: .plain, entries: go),
            .submenu(title: "Window", role: .window, entries: window),
            .submenu(title: "Help", role: .help, entries: help),
        ]
    }

    /// `setupDockMenu`.
    public static func dock(strings: ShellStrings) -> [MenuEntry] {
        [
            .item(MenuItemModel(strings.t("menu.newTransaction"), .action(.newTransaction))),
            .item(MenuItemModel(strings.t("nav.home"), .action(.navigate("/")))),
        ]
    }

    /// Every item with a key equivalent, depth first, for duplicate checks.
    public static func keyEquivalents(_ entries: [MenuEntry]) -> [(title: String, key: KeyEquivalent)] {
        entries.flatMap { entry -> [(title: String, key: KeyEquivalent)] in
            switch entry {
            case .item(let item):
                return item.keyEquivalent.map { [(item.title, $0)] } ?? []
            case .separator:
                return []
            case .submenu(_, _, let children):
                return keyEquivalents(children)
            }
        }
    }
}
