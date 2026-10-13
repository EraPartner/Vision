import Foundation
import Testing
@testable import VisionNativeCore

/// A rates service that answers from a script and counts calls.
actor FakeExchangeRatesService: ExchangeRatesService {
    var rates: [Result<OpenAPI.ExchangeRates, APIError>]
    var refreshes: [Result<OpenAPI.InfoMessage, APIError>]
    private(set) var rateCalls = 0
    private(set) var refreshCalls = 0

    init(
        rates: [Result<OpenAPI.ExchangeRates, APIError>] = [],
        refreshes: [Result<OpenAPI.InfoMessage, APIError>] = []
    ) {
        self.rates = rates
        self.refreshes = refreshes
    }

    func exchangeRates() async throws -> OpenAPI.ExchangeRates {
        rateCalls += 1
        guard !rates.isEmpty else { throw APIError.network("no script") }
        return try rates.removeFirst().get()
    }

    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage {
        refreshCalls += 1
        guard !refreshes.isEmpty else { throw APIError.network("no script") }
        return try refreshes.removeFirst().get()
    }
}

/// `app_settings` reads that answer from a script; the last answer repeats.
actor SettingsScript {
    private var answers: [NativeAppSettings]
    private(set) var calls = 0

    init(_ answers: [NativeAppSettings]) {
        self.answers = answers
    }

    func next() -> NativeAppSettings {
        calls += 1
        return answers.count > 1 ? answers.removeFirst() : answers[0]
    }
}

@MainActor
final class ShellRecorder {
    var actions: [MenuAction] = []
    var sidebar: [Bool] = []
    var saved: [[NavSectionID: Bool]] = []
}

@MainActor
@Suite struct NativeShellModelTests {
    func makeModel(
        settings: NativeAppSettings = NativeAppSettings(adminMode: true), recorder: ShellRecorder,
        hidden: [NavSectionID: Bool]? = nil
    ) -> NativeShellModel {
        NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]),
            theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            hiddenSections: hidden,
            loadSettings: { settings },
            saveHiddenSections: { recorder.saved.append($0) },
            onNavigate: { recorder.actions.append($0) },
            onSidebarVisibilityChange: { recorder.sidebar.append($0) },
            settingsReloadDelay: .milliseconds(1))
    }

    @Test func theReportHandoffPreservesTheTabAndReturnsAfterTheDialogCloses() throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/statistics?tab=yearly&window=all")))
        model.openStatisticsReport()
        #expect(model.isPresentingWeb)
        #expect(recorder.actions.last == .replaceRoute("/statistics?tab=yearly&window=all&export=pdf"))
        model.routeDidChange(try #require(NativeRoute("/statistics?tab=yearly&window=all&export=pdf")))
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/statistics?tab=yearly&window=all")))
        #expect(!model.isPresentingWeb)
        #expect(model.route.value("tab") == "yearly")
    }

    @Test func repeatedSettingsReadsRefreshNativePagesEvenWhenFormatsStayTheSame() {
        let model = makeModel(recorder: ShellRecorder())
        model.apply(settings: .defaults)
        let revision = model.settingsRevision
        model.apply(settings: .defaults)
        #expect(model.settingsRevision == revision + 1)
    }

    @Test func theTaxReportHandoffPreservesTheYearAndReturnsAfterClosing() throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/tax?year=2024")))
        model.openTaxReport()
        #expect(model.isPresentingWeb)
        #expect(recorder.actions.last == .replaceRoute("/tax?year=2024&export=pdf"))
        model.routeDidChange(try #require(NativeRoute("/tax?year=2024&export=pdf")))
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/tax?year=2024")))
        #expect(!model.isPresentingWeb)
        #expect(model.route.value("year") == "2024")
        #expect(NativeScreen.screen(forPath: "/tax") == .tax)
    }

    @Test func theExchangeRatesScreenIsNativeOnlyInAdminMode() async throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        // Settings are not known yet: the web app (and its RequireAdmin) shows the route.
        #expect(model.detail == .web)
        await model.settingsSettled()
        #expect(model.settingsLoaded)
        #expect(model.detail == .native(.exchangeRates))
        #expect(model.sections.last?.id == .admin)
        #expect(model.selectedItemURL == "/admin/exchange-rates")
        #expect(recorder.actions.isEmpty)
    }

    @Test func withoutAdminModeTheWebAppKeepsTheAdminRoute() async throws {
        // A stale `adminMode: false` (the page saves 500 ms after a change) must not move
        // the page: its RequireAdmin redirects and reports the new route itself.
        let recorder = ShellRecorder()
        let model = makeModel(settings: NativeAppSettings(adminMode: false), recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates?tab=fallback")))
        await model.settingsSettled()
        #expect(model.route.path == "/admin/exchange-rates")
        #expect(model.detail == .web)
        #expect(recorder.actions.isEmpty)
        #expect(!model.sections.contains { $0.id == .admin })
    }

    @Test func closingSettingsReadsThemAgainAfterThePageSaved() async throws {
        let recorder = ShellRecorder()
        let off = NativeAppSettings(adminMode: false)
        // The route report and the immediate read on close see the old value; the delayed
        // read sees the saved one.
        let script = SettingsScript([off, off, NativeAppSettings(adminMode: true)])
        let model = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]),
            theme: ThemeSelection(appearance: .light),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            loadSettings: { await script.next() },
            onNavigate: { recorder.actions.append($0) },
            settingsReloadDelay: .milliseconds(100))
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates?settings=general")))
        await model.settingsSettled()
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        await model.settingsSettled()
        let calls = await script.calls
        #expect(calls == 3)
        #expect(model.settings.adminMode)
        #expect(model.detail == .native(.exchangeRates))
        #expect(recorder.actions.isEmpty)
    }

    @Test func sidebarClicksWaitForThePageToMove() throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.navigate(to: "/transactions")
        // The page may hold the route behind an unsaved-changes prompt, so nothing moves yet.
        #expect(model.route == .home)
        #expect(model.selectedItemURL == NavigationRegistry.matchItem(path: "/")?.url)
        #expect(model.pendingRoute?.path == "/transactions")
        #expect(recorder.actions == [.navigate("/transactions")])
        model.routeDidChange(try #require(NativeRoute("/transactions")))
        #expect(model.route.path == "/transactions")
        #expect(model.pendingRoute == nil)
        model.navigate(to: "https://example.com")
        #expect(recorder.actions.count == 1)
    }

    @Test func theTabIsWrittenToTheQueryWithReplace() async throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        #expect(ExchangeRatesTab(route: model.route) == .live)
        model.replaceQuery("tab", with: ExchangeRatesTab.fallback.rawValue)
        #expect(ExchangeRatesTab(route: model.route) == .fallback)
        #expect(recorder.actions == [.replaceRoute("/admin/exchange-rates?tab=fallback")])
        #expect(ExchangeRatesTab(route: NativeRoute(path: "/x", query: [URLQueryItem(name: "tab", value: "bogus")])) == .live)
    }

    @Test func pageDialogsShowTheWebViewUntilTheRouteMoves() async throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        await model.settingsSettled()
        #expect(model.handleKey("k", command: true))
        #expect(model.detail == .web)
        #expect(recorder.actions == [.openPalette])
        // The palette closed without navigating: the page reports the same route again.
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        #expect(model.detail == .native(.exchangeRates))
        #expect(model.handleKey("k", command: true))
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/admin")))
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        await model.settingsSettled()
        #expect(model.detail == .native(.exchangeRates))

        model.openSettings()
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates?settings=general")))
        #expect(model.detail == .web)
        model.routeDidChange(try #require(NativeRoute("/admin/exchange-rates")))
        #expect(model.detail == .native(.exchangeRates))
        #expect(recorder.actions.last == .openSettings)
    }

    @Test func shortcutsNavigateFromANativeScreen() {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        let now = Date(timeIntervalSinceReferenceDate: 0)
        #expect(model.handleKey("g", now: now))
        #expect(model.handleKey("t", now: now + 0.1))
        #expect(recorder.actions == [.navigate("/transactions")])
        #expect(!model.handleKey("q", now: now + 5))
    }

    @Test func sectionsFollowTheStoredChoiceAndOpenForTheActivePage() throws {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        let research = try #require(NavigationRegistry.sections.first { $0.id == .research })
        let money = try #require(NavigationRegistry.sections.first { $0.id == .money })
        // `defaultHidden`.
        #expect(!model.isSectionExpanded(research))
        #expect(model.isSectionExpanded(money))
        model.setSection(.money, expanded: false)
        #expect(!model.isSectionExpanded(money))
        #expect(recorder.saved.last?[.money] == true)
        // Landing inside a hidden section shows it for good.
        model.routeDidChange(try #require(NativeRoute("/research/markets")))
        #expect(model.isSectionExpanded(research))
        #expect(model.hiddenSections[.research] == false)
    }

    @Test func toggleSidebarReportsTheNewState() {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.toggleSidebar()
        #expect(!model.isSidebarVisible)
        model.setSidebarVisible(false)
        model.toggleSidebar()
        #expect(recorder.sidebar == [false, true])
        #expect(MenuAction.nativeSidebar(visible: false) == MenuAction("native-sidebar", payload: "hidden"))
    }

    @Test func settingsApplyTheColorblindSkin() {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.apply(settings: NativeAppSettings(colorblindGainLoss: true))
        #expect(model.theme.colorblindGainLoss)
    }
}
