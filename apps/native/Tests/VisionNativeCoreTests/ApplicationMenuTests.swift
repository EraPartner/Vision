import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct ApplicationMenuTests {
    static let english = ShellStrings(
        language: .en,
        table: [
            "menu.settings": "Settings…", "menu.file": "File", "menu.edit": "Edit", "menu.view": "View",
            "menu.go": "Go", "menu.newTransaction": "New transaction", "menu.importCsv": "Import CSV…",
            "menu.toggleSidebar": "Toggle Sidebar", "menu.appearance": "Appearance",
            "menu.keyboardShortcuts": "Keyboard Shortcuts", "menu.sourceCode": "Source Code",
            "menu.documentation": "Documentation", "nav.home": "Home", "layout.light": "Light",
        ])

    private func submenu(_ entries: [MenuEntry], _ title: String) -> [MenuEntry] {
        for entry in entries {
            if case .submenu(let submenuTitle, _, let children) = entry, submenuTitle == title { return children }
        }
        Issue.record("missing submenu \(title)")
        return []
    }

    private func items(_ entries: [MenuEntry]) -> [MenuItemModel] {
        entries.compactMap { entry in
            if case .item(let item) = entry { return item }
            return nil
        }
    }

    @Test func topLevelMenusMatchElectron() {
        let menu = ApplicationMenu.build(appName: "Vision Native", strings: Self.english)
        let titles = menu.compactMap { entry -> String? in
            if case .submenu(let title, _, _) = entry { return title }
            return nil
        }
        #expect(titles == ["Vision Native", "File", "Edit", "View", "Go", "Window", "Help"])
    }

    @Test func appMenuHasSettingsAndNoUpdateCheck() {
        let app = items(
            submenu(ApplicationMenu.build(appName: "Vision Native", strings: Self.english), "Vision Native"))
        #expect(
            app.map(\.title) == [
                "About Vision Native", "Settings…", "Hide Vision Native", "Hide Others", "Show All",
                "Quit Vision Native",
            ])
        #expect(app[1].command == .renderer(.openSettings))
        #expect(app[1].keyEquivalent == KeyEquivalent(","))
        #expect(!app.contains { $0.title.localizedCaseInsensitiveContains("update") })
    }

    @Test func rendererItemsCarryElectronsActionsAndShortcuts() {
        let menu = ApplicationMenu.build(appName: "Vision Native", strings: Self.english)
        let file = items(submenu(menu, "File"))
        #expect(
            file.map(\.command) == [.renderer(.newTransaction), .renderer(.navigate("/import")), .print, .closeWindow])
        #expect(
            file.map(\.keyEquivalent) == [
                KeyEquivalent("n"), KeyEquivalent("i", [.command, .shift]), KeyEquivalent("p"), KeyEquivalent("w"),
            ])
        let view = items(submenu(menu, "View"))
        #expect(view.first?.command == .renderer(.toggleSidebar))
        #expect(view.first?.keyEquivalent == KeyEquivalent("s", [.command, .control]))
        let appearance = items(submenu(submenu(menu, "View"), "Appearance"))
        #expect(
            appearance.map(\.command)
                == ["light", "dark", "system", "schedule"].map { MenuCommand.renderer(.setTheme($0)) })
        #expect(appearance.first?.title == "Light")
        let help = items(submenu(menu, "Help"))
        #expect(
            help.map(\.command) == [
                .renderer(.openShortcuts), .openExternal(ShellLinks.repository),
                .openExternal(ShellLinks.documentation),
            ])
    }

    @Test func goMenuUsesCommandDigitsInRouteOrder() {
        let go = items(submenu(ApplicationMenu.build(appName: "Vision Native", strings: Self.english), "Go"))
        #expect(go.count == 9)
        #expect(go.map(\.keyEquivalent) == (1...9).map { Optional(KeyEquivalent("\($0)")) })
        #expect(go.map(\.command) == ApplicationMenu.goRoutes.map { MenuCommand.renderer(.navigate($0.path)) })
        #expect(go.first?.title == "Home")
        // A missing translation falls back to the key, like t().
        #expect(go[1].title == "nav.transactions")
    }

    @Test func zoomInAlsoAnswersPlainCommandEquals() {
        let view = items(submenu(ApplicationMenu.build(appName: "Vision Native", strings: Self.english), "View"))
        let zoomIn = view.filter { $0.command == .zoomIn }
        #expect(zoomIn.map(\.keyEquivalent) == [KeyEquivalent("+"), KeyEquivalent("=")])
        #expect(zoomIn.map(\.isHidden) == [false, true])
        #expect(view.filter(\.isHidden).count == 1)
    }

    @Test func developerToolsAreOnlyInTheDebugMenu() {
        let release = items(submenu(ApplicationMenu.build(appName: "Vision Native", strings: Self.english), "View"))
        #expect(!release.contains { $0.command == .toggleDeveloperTools })
        let debugMenu = ApplicationMenu.build(appName: "Vision Native", strings: Self.english, includeDeveloperTools: true)
        let debug = items(submenu(debugMenu, "View"))
        let tools = debug.filter { $0.command == .toggleDeveloperTools }
        #expect(tools.map(\.keyEquivalent) == [KeyEquivalent("i", [.command, .option])])
        let reload = debug.firstIndex { $0.command == .reload }
        #expect(reload.map { debug[$0 + 1].command } == .toggleDeveloperTools)
        let keys = ApplicationMenu.keyEquivalents(debugMenu)
        #expect(Set(keys.map(\.key)).count == keys.count)
    }

    @Test func keyEquivalentsAreUnique() {
        let keys = ApplicationMenu.keyEquivalents(
            ApplicationMenu.build(appName: "Vision Native", strings: Self.english))
        #expect(Set(keys.map(\.key)).count == keys.count)
        #expect(
            keys.contains { $0.key == KeyEquivalent("f", [.command, .control]) && $0.title == "Toggle Full Screen" })
    }

    @Test func dutchLabelsComeFromTheSameKeys() {
        let dutch = ShellStrings(
            language: .nl, table: ["menu.file": "Archief", "menu.newTransaction": "Nieuwe transactie"])
        let menu = ApplicationMenu.build(appName: "Vision Native", strings: dutch)
        #expect(items(submenu(menu, "Archief")).first?.title == "Nieuwe transactie")
        // Role items keep Electron's English labels.
        #expect(items(submenu(menu, "Window")).map(\.title) == ["Minimize", "Zoom", "Bring All to Front"])
    }

    @Test func dockMenuOffersNewTransactionAndHome() {
        let dock = items(ApplicationMenu.dock(strings: Self.english))
        #expect(dock.map(\.title) == ["New transaction", "Home"])
        #expect(dock.map(\.command) == [.renderer(.newTransaction), .renderer(.navigate("/"))])
    }
}

@Suite struct ShellStringsTests {
    @Test func languageFollowsTheSettingThenTheSystem() {
        #expect(ShellStrings.resolveLanguage(requested: .string("nl"), preferredLanguages: ["en-GB"]) == .nl)
        #expect(ShellStrings.resolveLanguage(requested: .string("de"), preferredLanguages: ["nl-BE"]) == .nl)
        #expect(ShellStrings.resolveLanguage(requested: nil, preferredLanguages: ["fr-BE", "nl-BE"]) == .en)
        #expect(ShellStrings.resolveLanguage(requested: nil, preferredLanguages: []) == .en)
    }

    @Test func translateSubstitutesAndFallsBack() {
        let strings = ShellStrings(language: .en, table: ["menu.about": "About {app}", "empty": ""])
        #expect(strings.t("menu.about", ["app": "Vision Native"]) == "About Vision Native")
        #expect(strings.t("missing", fallback: "Fallback") == "Fallback")
        #expect(strings.t("missing") == "missing")
        #expect(strings.t("empty", fallback: "Used") == "Used")
    }

    @Test func loadsTheRequestedLanguageElseEnglish() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(
            "shell-strings-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        try Data(#"{"menu.file":"File","count":3}"#.utf8).write(to: directory.appendingPathComponent("en.json"))
        let english = ShellStrings.load(language: .nl, directory: directory.path)
        #expect(english.language == .nl)
        #expect(english.t("menu.file") == "File")
        #expect(english.t("count") == "count")
        try Data(#"{"menu.file":"Archief"}"#.utf8).write(to: directory.appendingPathComponent("nl.json"))
        #expect(ShellStrings.load(language: .nl, directory: directory.path).t("menu.file") == "Archief")
        #expect(ShellStrings.load(language: .en, directory: nil).t("menu.file") == "menu.file")
    }
}
