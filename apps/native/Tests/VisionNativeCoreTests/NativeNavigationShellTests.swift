import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native routing opt-in shell integration")
struct NativeNavigationShellTests {
    private func makeModel(
        initial: String = "/transactions", enabled: Bool = true, loaded: Bool = true,
        adminMode: Bool = true, recorder: ShellRecorder, reports: NativeReportModel? = nil,
        initialRoute: NativeRoute = .home,
        loadSettings: (@Sendable () async throws -> NativeAppSettings)? = nil
    ) -> NativeShellModel {
        let settings = NativeAppSettings(adminMode: adminMode)
        let model = NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]), theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(), planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(), accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            nativeSettings: NativeSettingsModel(client: APIClient(baseURL: { nil }, adminToken: { nil })),
            reports: reports, nativeFallback: true, initialRoute: initialRoute,
            nativeNavigation: enabled ? NativeNavigationHistory(initial: NativeNavigationLocation(initial)!) : nil,
            loadSettings: loadSettings ?? { settings }, onNavigate: { recorder.actions.append($0) })
        if loaded { model.apply(settings: settings) }
        return model
    }

    @Test func optInCommitsLocallyAndRendererReportsCannotOverrideIt() async {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.navigate(to: "/ACCOUNTS/42/?q=a+b&x=%2f&flag")
        #expect(model.route.path == "/accounts/42")
        #expect(model.detail == .native(.accountDetail(id: 42)))
        #expect(model.nativeNavigationLocation?.raw == "/accounts/42?q=a+b&x=%2f&flag")
        #expect(model.pendingRoute == nil && model.canGoBack && recorder.actions.isEmpty)
        model.routeDidChange(.home)
        #expect(model.route.path == "/accounts/42")
        model.goBack()
        #expect(model.route.path == "/transactions" && model.canGoForward)
        model.goForward()
        #expect(model.nativeNavigationLocation?.raw == "/accounts/42?q=a+b&x=%2f&flag")
        await model.settingsSettled()
    }

    @Test func defaultStillWaitsForRendererAndHasNoNativeHistory() async {
        let recorder = ShellRecorder()
        let model = makeModel(enabled: false, recorder: recorder)
        model.navigate(to: "/accounts")
        #expect(model.route == .home && model.pendingRoute?.path == "/accounts")
        #expect(recorder.actions == [.navigate("/accounts")])
        #expect(model.nativeNavigationLocation == nil && !model.canGoBack && !model.canGoForward)
        model.routeDidChange(NativeRoute("/accounts")!)
        #expect(model.route.path == "/accounts" && model.pendingRoute == nil)
        await model.settingsSettled()
    }

    @Test func blockedReplacementAndTraversalKeepDraftUntilExactlyOneDiscard() async {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        var dirty = true
        var discards = 0
        model.setLeaveGuard(
            .init(
                id: "/transactions", hasUnsavedChanges: { dirty },
                discard: {
                    dirty = false
                    discards += 1
                }))
        model.replace(with: "/accounts/1")
        #expect(model.route.path == "/transactions" && model.leaveConfirmation?.path == "/accounts/1")
        #expect(model.nativeNavigation?.count == 1 && recorder.actions.isEmpty)
        model.stayOnPage()
        #expect(model.leaveConfirmation == nil && dirty && discards == 0)
        model.navigate(to: "/planned")
        model.leavePage()
        model.leavePage()
        #expect(model.route.path == "/planned" && discards == 1 && model.nativeNavigation?.count == 2)
        dirty = true
        model.goBack()
        #expect(model.route.path == "/planned" && model.leaveConfirmation?.path == "/transactions")
        model.leavePage()
        #expect(model.route.path == "/transactions" && discards == 2 && model.nativeNavigation?.count == 2)
        #expect(model.canGoForward)
        await model.settingsSettled()
    }

    @Test func queryAndSettingsTransitionsKeepDraftAndSourceHistorySemantics() async {
        let recorder = ShellRecorder()
        let initial = "/transactions?q=a+b&flag&account_id=2"
        let model = makeModel(initial: initial, recorder: recorder)
        var discards = 0
        model.setLeaveGuard(.init(id: "/transactions", hasUnsavedChanges: { true }, discard: { discards += 1 }))
        model.openSettings()
        #expect(model.isPresentingNativeSettings && model.nativeNavigation?.count == 2)
        model.selectSettingsSection("backup")
        #expect(model.settingsSection == "backup" && model.nativeNavigation?.count == 2)
        model.closeSettings()
        #expect(model.nativeNavigationLocation?.raw == initial && model.nativeNavigation?.index == 0)
        model.replaceQuery("search", with: "x y~*")
        #expect(model.nativeNavigationLocation?.raw == "/transactions?q=a+b&flag=&account_id=2&search=x+y%7E*")
        #expect(model.leaveConfirmation == nil && discards == 0 && recorder.actions.isEmpty)
        await model.settingsSettled()
    }

    @Test func settingsDirectLinkCloseReplacesWithoutBackAndKeepsExport() async {
        let recorder = ShellRecorder()
        let model = makeModel(initial: "/transactions?settings=about&export=pdf&account_id=7", recorder: recorder)
        model.closeSettings()
        #expect(model.nativeNavigation?.count == 1 && !model.canGoBack)
        #expect(model.nativeNavigationLocation?.raw == "/transactions?export=pdf&account_id=7")
        #expect(recorder.actions.isEmpty)
        await model.settingsSettled()
    }

    @Test func hydrationAndLegacyRedirectsResolveWithoutRendererNavigation() async {
        let recorder = ShellRecorder()
        let admin = makeModel(initial: "/ADMIN/DB/?keep=discard", loaded: false, adminMode: false, recorder: recorder)
        #expect(!admin.settingsLoaded && admin.route.path == "/ADMIN/DB/")
        admin.apply(settings: NativeAppSettings(adminMode: false))
        #expect(admin.route == .home && admin.nativeNavigation?.count == 1)
        let legacy = makeModel(initial: "/portfolio/performance?period=1y&q=a+b&flag", recorder: recorder)
        #expect(legacy.route.path == "/portfolio")
        #expect(legacy.nativeNavigationLocation?.raw == "/portfolio?period=1y&q=a+b&flag")
        #expect(legacy.nativeNavigation?.count == 1 && recorder.actions.isEmpty)
        await admin.settingsSettled()
        await legacy.settingsSettled()
    }

    @Test func reportDeepLinkHydratesAndCloseReplacesOnlyItsQuery() async {
        let recorder = ShellRecorder()
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let model = makeModel(initial: "/tax?year=2024&export=pdf&q=a+b", recorder: recorder, reports: report)
        #expect(report.isPresented && report.type == .tax && model.route.value("year") == "2024")
        model.closeReport()
        #expect(!report.isPresented && model.nativeNavigationLocation?.raw == "/tax?year=2024&q=a+b")
        #expect(model.nativeNavigation?.count == 1 && recorder.actions.isEmpty)
        model.openTaxReport()
        #expect(report.isPresented && !model.isPresentingWeb && model.nativeNavigation?.count == 1)
        await model.settingsSettled()
    }

    @Test func legacyRestoreSeedKeepsSettingsAndReportQueryBeforeReadinessWithoutSideEffects() async {
        let recorder = ShellRecorder()
        let settings = SettingsScript([NativeAppSettings(adminMode: true)])
        let initial = NativeRoute("/tax?year=2024&settings=backup&export=pdf&unrelated=keep")!
        let model = makeModel(
            enabled: false, loaded: false, recorder: recorder, initialRoute: initial,
            loadSettings: { await settings.next() })
        #expect(model.route == initial && !model.settingsLoaded && !model.isRendererReady)
        #expect(model.settingsSection == "backup" && model.route.value("export") == "pdf")
        #expect(model.nativeOverlayKind == nil)
        #expect(model.nativeNavigation == nil && model.pendingRoute == nil && recorder.actions.isEmpty)
        await model.settingsSettled()
        #expect(await settings.calls == 0)
        // A genuinely newer renderer report still wins over the constructor seed.
        model.routeDidChange(NativeRoute("/accounts/9?since=2024-01-01")!)
        await model.settingsSettled()
        #expect(model.route.path == "/accounts/9" && model.route.value("since") == "2024-01-01")
    }

    @Test func legacyRestoreSeedActivatesReportOnSettingsReadWithoutAnotherRendererReport() async {
        let recorder = ShellRecorder()
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let initial = NativeRoute("/tax?year=2024&settings=backup&export=pdf")!
        let model = makeModel(enabled: false, loaded: false, recorder: recorder, reports: report, initialRoute: initial)
        #expect(!report.isPresented && recorder.actions.isEmpty)
        #expect(model.nativeOverlayKind == nil)
        model.apply(settings: NativeAppSettings(adminMode: true))
        #expect(!report.isPresented && model.nativeOverlayKind == nil && model.detail == .web)
        model.isRendererReady = true
        model.apply(settings: NativeAppSettings(adminMode: true))
        #expect(report.isPresented && report.type == .tax && model.route == initial)
        #expect(model.nativeOverlayKind == .settings)
        // An accepted restore may lower readiness while its existing wizard stays mounted.
        model.isRendererReady = false
        #expect(model.nativeOverlayKind == .settings)
        #expect(recorder.actions.isEmpty)
        await model.settingsSettled()
    }
}
