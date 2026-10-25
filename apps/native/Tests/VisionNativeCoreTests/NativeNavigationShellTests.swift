import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native navigation shell integration")
struct NativeNavigationShellTests {
    private func makeModel(
        initial: String = "/transactions", loaded: Bool = true, adminMode: Bool = true,
        reports: NativeReportModel? = nil,
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
            nativeSettings: NativeSettingsModel(client: APIClient(baseURL: { nil })),
            reports: reports, nativeNavigation: NativeNavigationHistory(initial: NativeNavigationLocation(initial)!),
            loadSettings: loadSettings ?? { settings })
        if loaded { model.apply(settings: settings) }
        return model
    }

    @Test func navigationCommitsLocallyAndKeepsTheRawLocation() async {
        let model = makeModel()
        model.navigate(to: "/ACCOUNTS/42/?q=a+b&x=%2f&flag")
        #expect(model.route.path == "/accounts/42")
        #expect(model.detail == .loading)
        #expect(model.nativeNavigationLocation.raw == "/accounts/42?q=a+b&x=%2f&flag")
        #expect(model.canGoBack)
        model.goBack()
        #expect(model.route.path == "/transactions" && model.canGoForward)
        model.goForward()
        #expect(model.nativeNavigationLocation.raw == "/accounts/42?q=a+b&x=%2f&flag")
        await model.settingsSettled()
    }

    @Test func blockedReplacementAndTraversalKeepDraftUntilExactlyOneDiscard() async {
        let model = makeModel()
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
        #expect(model.nativeNavigation.count == 1)
        model.stayOnPage()
        #expect(model.leaveConfirmation == nil && dirty && discards == 0)
        model.navigate(to: "/planned")
        model.leavePage()
        model.leavePage()
        #expect(model.route.path == "/planned" && discards == 1 && model.nativeNavigation.count == 2)
        dirty = true
        model.goBack()
        #expect(model.route.path == "/planned" && model.leaveConfirmation?.path == "/transactions")
        model.leavePage()
        #expect(model.route.path == "/transactions" && discards == 2 && model.nativeNavigation.count == 2)
        #expect(model.canGoForward)
        await model.settingsSettled()
    }

    @Test func queryAndSettingsTransitionsKeepDraftAndSourceHistorySemantics() async {
        let initial = "/transactions?q=a+b&flag&account_id=2"
        let model = makeModel(initial: initial)
        var discards = 0
        model.setLeaveGuard(.init(id: "/transactions", hasUnsavedChanges: { true }, discard: { discards += 1 }))
        model.openSettings()
        #expect(model.isPresentingNativeSettings && model.nativeNavigation.count == 2)
        model.selectSettingsSection("backup")
        #expect(model.settingsSection == "backup" && model.nativeNavigation.count == 2)
        model.closeSettings()
        #expect(model.nativeNavigationLocation.raw == initial && model.nativeNavigation.index == 0)
        model.replaceQuery("search", with: "x y~*")
        #expect(model.nativeNavigationLocation.raw == "/transactions?q=a+b&flag=&account_id=2&search=x+y%7E*")
        #expect(model.leaveConfirmation == nil && discards == 0)
        await model.settingsSettled()
    }

    @Test func settingsDirectLinkCloseReplacesWithoutBackAndKeepsExport() async {
        let model = makeModel(initial: "/transactions?settings=about&export=pdf&account_id=7")
        model.closeSettings()
        #expect(model.nativeNavigation.count == 1 && !model.canGoBack)
        #expect(model.nativeNavigationLocation.raw == "/transactions?export=pdf&account_id=7")
        await model.settingsSettled()
    }

    @Test func hydrationAndLegacyRedirectsResolveWithoutAnyOtherNavigation() async {
        let admin = makeModel(initial: "/ADMIN/DB/?keep=discard", loaded: false, adminMode: false)
        #expect(!admin.settingsLoaded && admin.route.path == "/ADMIN/DB/")
        admin.apply(settings: NativeAppSettings(adminMode: false))
        #expect(admin.route == .home && admin.nativeNavigation.count == 1)
        let legacy = makeModel(initial: "/portfolio/performance?period=1y&q=a+b&flag")
        #expect(legacy.route.path == "/portfolio")
        #expect(legacy.nativeNavigationLocation.raw == "/portfolio?period=1y&q=a+b&flag")
        #expect(legacy.nativeNavigation.count == 1)
        await admin.settingsSettled()
        await legacy.settingsSettled()
    }

    @Test func reportDeepLinkHydratesAndCloseReplacesOnlyItsQuery() async {
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let model = makeModel(initial: "/tax?year=2024&export=pdf&q=a+b", reports: report)
        #expect(report.isPresented && report.type == .tax && model.route.value("year") == "2024")
        model.closeReport()
        #expect(!report.isPresented && model.nativeNavigationLocation.raw == "/tax?year=2024&q=a+b")
        #expect(model.nativeNavigation.count == 1)
        model.openTaxReport()
        #expect(report.isPresented && model.nativeNavigation.count == 1)
        await model.settingsSettled()
    }

    @Test func aDeepLinkWithSettingsAndReportQueryActivatesOnceTheSettingsAreRead() async {
        let settings = SettingsScript([NativeAppSettings(adminMode: true)])
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let initial = "/tax?year=2024&settings=backup&export=pdf&unrelated=keep"
        let model = makeModel(
            initial: initial, loaded: false, reports: report, loadSettings: { await settings.next() })
        #expect(!model.settingsLoaded && !report.isPresented)
        #expect(model.settingsSection == "backup" && model.route.value("export") == "pdf")
        model.apply(settings: NativeAppSettings(adminMode: true))
        #expect(report.isPresented && report.type == .tax)
        #expect(model.nativeOverlayKind == .settings)
        #expect(await settings.calls == 0)
        await model.settingsSettled()
    }
}
