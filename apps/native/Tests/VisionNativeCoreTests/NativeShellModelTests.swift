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

private actor ShellSettingsReadGate {
    private var reply: CheckedContinuation<NativeAppSettings, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func read() async -> NativeAppSettings {
        await withCheckedContinuation { continuation in
            reply = continuation
            entered?.resume()
            entered = nil
        }
    }
    func waitForRead() async {
        if reply == nil { await withCheckedContinuation { entered = $0 } }
    }
    func release(_ settings: NativeAppSettings) {
        reply?.resume(returning: settings)
        reply = nil
    }
}

@MainActor
final class ShellRecorder {
    var actions: [MenuAction] = []
    var sidebar: [Bool] = []
    var saved: [[NavSectionID: Bool]] = []
    var clipboard: [String] = []
    var acceptsClipboard = true
}

@MainActor
@Suite struct NativeShellModelTests {
    func makeModel(
        settings: NativeAppSettings = NativeAppSettings(adminMode: true), recorder: ShellRecorder,
        hidden: [NavSectionID: Bool]? = nil, portfolio: PortfolioScreens? = nil,
        portfolioImports: PortfolioImportScreens? = nil, tax: TaxScreens? = nil,
        analysis: AnalysisScreens? = nil, analysisMonitors: AnalysisMonitorsModel? = nil,
        research: ResearchScreens? = nil, researchForecast: ResearchForecastScreens? = nil,
        researchChartBuilder: ResearchChartBuilderModel? = nil, researchDossiers: ResearchDossiersModel? = nil,
        aiChat: AIChatScreens? = nil, nativeSettings: NativeSettingsModel? = nil,
        commandPalette: NativeCommandPaletteModel? = nil, reports: NativeReportModel? = nil,
        nativeFallback: Bool = false,
        loadSettings: (@Sendable () async throws -> NativeAppSettings)? = nil
    ) -> NativeShellModel {
        NativeShellModel(
            strings: DictionaryStrings(language: .en, table: [:]),
            theme: ThemeSelection(appearance: .light),
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
            exchangeRates: ExchangeRatesModel(service: FakeExchangeRatesService()),
            admin: AdminFixture.screens(),
            planned: PlannedFixture.idleModel(), imports: ImportFixture.idleModel(),
            transactions: TransactionsFixture.idleModel(),
            accounts: AccountsFixture.idleModel(),
            categories: CategoriesFixture.idleModel(), recipients: RecipientsFixture.idleModel(),
            tax: tax,
            portfolio: portfolio,
            portfolioImports: portfolioImports,
            analysis: analysis,
            analysisMonitors: analysisMonitors,
            research: research,
            researchForecast: researchForecast,
            researchChartBuilder: researchChartBuilder,
            researchDossiers: researchDossiers,
            aiChat: aiChat,
            nativeSettings: nativeSettings,
            commandPalette: commandPalette,
            reports: reports,
            nativeFallback: nativeFallback,
            hiddenSections: hidden,
            loadSettings: loadSettings ?? { settings },
            saveHiddenSections: { recorder.saved.append($0) },
            onNavigate: { recorder.actions.append($0) },
            copyToClipboard: {
                guard recorder.acceptsClipboard else { return false }
                recorder.clipboard.append($0)
                return true
            },
            onSidebarVisibilityChange: { recorder.sidebar.append($0) },
            settingsReloadDelay: .milliseconds(1))
    }

    @Test func nativeOverlayPriorityPreservesSettingsRouteAndPaletteCopyAcknowledgement() async throws {
        let recorder = ShellRecorder()
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let palette = NativeCommandPaletteModel(
            service: client, answers: NativeCommandPaletteAnswerProvider { _, _, _, _ in nil })
        let model = makeModel(
            recorder: recorder, nativeSettings: NativeSettingsModel(client: client), commandPalette: palette)
        let route = try #require(NativeRoute("/planned?settings=general&unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        #expect(model.detail == .native(.plannedPayments) && model.nativeOverlayKind == .settings)
        model.openShortcuts()
        #expect(model.nativeOverlayKind == .shortcuts)
        model.openPalette()
        #expect(model.nativeOverlayKind == .palette && model.route == route)
        await model.closeNativeOverlay()
        #expect(model.nativeOverlayKind == .shortcuts)
        await model.closeNativeOverlay()
        #expect(model.nativeOverlayKind == .settings && model.route == route)
        #expect(recorder.actions.isEmpty)
        recorder.acceptsClipboard = false
        model.activatePaletteAction(.copy("123.45"))
        #expect(model.notices.entries.isEmpty && recorder.clipboard.isEmpty)
        recorder.acceptsClipboard = true
        model.activatePaletteAction(.copy("123.45"))
        #expect(recorder.clipboard == ["123.45"])
        #expect(model.notices.entries.last?.notice.key == "commandPalette.copied")
    }

    @Test func nativeReportCloseRemovesOnlyItsQueryAndUnknownRoutesUseNativeFallback() async throws {
        let recorder = ShellRecorder()
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let model = makeModel(recorder: recorder, reports: report, nativeFallback: true)
        model.routeDidChange(try #require(NativeRoute("/planned?unrelated=keep")))
        await model.settingsSettled()
        model.routeDidChange(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.isPresented && report.type == .tax)
        #expect(report.periodPreset == .rolling12)
        report.setType(.portfolio)
        report.periodPreset = .year
        report.customYear = "2014"
        report.currency = "JPY"
        model.routeDidChange(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.type == .portfolio && report.customYear == "2014" && report.currency == "JPY")
        model.closeReport()
        #expect(!report.isPresented)
        #expect(recorder.actions.last == .replaceRoute("/tax?year=2020&unrelated=keep"))
        model.routeDidChange(try #require(NativeRoute("/tax?year=2020&unrelated=keep")))
        model.routeDidChange(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.type == .portfolio && report.periodPreset == .year && report.currency == "JPY")
        model.routeDidChange(try #require(NativeRoute("/unknown?unrelated=keep")))
        #expect(model.detail == .notFound)
        model.routeDidChange(try #require(NativeRoute("/tax?export=pdf")))
        #expect(report.type == .tax && report.periodPreset == .rolling12)
        model.routeDidChange(try #require(NativeRoute("/portfolio/performance")))
        #expect(model.detail == .web)
    }

    @Test func pageZoomKeepsSourceBoundsAndReloadFencesNativeShortcutInput() async {
        let recorder = ShellRecorder()
        let model = makeModel(recorder: recorder)
        model.setPageZoom(1.2)
        #expect(model.pageZoom == 1.2)
        model.setPageZoom(.nan)
        model.setPageZoom(.infinity)
        #expect(model.pageZoom == 1.2)
        model.setPageZoom(0)
        #expect(model.pageZoom == PageZoom.minimumFactor)
        model.setPageZoom(100)
        #expect(model.pageZoom == PageZoom.maximumFactor)
        model.isReloadingGraph = true
        #expect(model.handleKey("k", command: true))
        model.openPalette()
        model.openShortcuts()
        model.activatePaletteAction(.copy("synthetic"))
        #expect(recorder.actions.isEmpty && recorder.clipboard.isEmpty)
        model.isReloadingGraph = false
        model.openPalette()
        #expect(recorder.actions == [.openPalette])
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

    @Test func onboardingRetainsTheNativePageAndReturnsOnTheSameRoute() async throws {
        let model = makeModel(recorder: ShellRecorder())
        let route = try #require(NativeRoute("/planned?unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        #expect(model.detail == .native(.plannedPayments))
        model.isPresentingOnboarding = true
        model.routeDidChange(route)
        #expect(model.detail == .web)
        #expect(model.isTemporarilyCovered("/planned"))
        model.isPresentingOnboarding = false
        model.routeDidChange(route)
        #expect(model.detail == .native(.plannedPayments))
        #expect(model.route == route)
    }

    @Test func nativeSettingsSectionChangesPreserveTheRouteAndCloseThroughItsRouter() async throws {
        let recorder = ShellRecorder()
        let preferences = NativeSettingsModel(client: APIClient(baseURL: { nil }, adminToken: { nil }))
        let model = makeModel(recorder: recorder, nativeSettings: preferences)
        let route = try #require(NativeRoute("/planned?settings=general&unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        #expect(model.isPresentingNativeSettings && model.detail == .native(.plannedPayments))
        model.selectSettingsSection("backup")
        #expect(recorder.actions.last == .replaceRoute("/planned?settings=backup&unrelated=keep"))
        #expect(model.route == route)
        let actionCount = recorder.actions.count
        model.selectSettingsSection("unknown")
        #expect(recorder.actions.count == actionCount)
        model.closeSettings()
        #expect(recorder.actions.last == .closeSettings)
        model.routeDidChange(route.removing("settings"))
        #expect(!model.isPresentingNativeSettings && model.detail == .native(.plannedPayments))
        #expect(model.route.value("unrelated") == "keep")
        #expect(model.nativeSettings === preferences)
    }

    @Test func aSettingsReadStartedBeforeALiveEditCannotRewindIt() async {
        let gate = ShellSettingsReadGate()
        let model = makeModel(recorder: ShellRecorder(), loadSettings: { await gate.read() })
        model.reloadSettings()
        await gate.waitForRead()
        model.apply(settings: NativeAppSettings(language: "nl"))
        await gate.release(.defaults)
        await model.settingsSettled()
        #expect(model.settings.language == "nl")
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

    @Test(arguments: [
        "/portfolio", "/portfolio/stocks", "/portfolio/crypto", "/portfolio/metals", "/portfolio/real-estate",
        "/portfolio/savings",
    ])
    func portfolioReportPreservesItsOriginAndQueryAndReturnsToNative(path: String) async throws {
        let recorder = ShellRecorder()
        let screens = PortfolioScreens(client: APIClient(baseURL: { nil }, adminToken: { nil }))
        let model = makeModel(recorder: recorder, portfolio: screens)
        let original = try #require(NativeRoute(path + "?period=1y&fx_neutral=true"))
        model.routeDidChange(original)
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        model.openPortfolioReport()
        #expect(recorder.actions.last == .replaceRoute(original.setting("export", to: "pdf").string))
        model.routeDidChange(original.setting("export", to: "pdf"))
        #expect(model.detail == .web)
        model.routeDidChange(original)
        #expect(!model.isPresentingWeb)
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route.value("period") == "1y" && model.route.value("fx_neutral") == "true")
    }

    @Test(arguments: [
        "/portfolio/import", "/portfolio/import/7/review", "/portfolio/import/invalid/review", "/portfolio/tax",
    ])
    func remainingPortfolioScreensAreNativeWithoutAdminMode(path: String) async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            portfolio: PortfolioScreens(client: client), portfolioImports: PortfolioImportScreens(service: client),
            tax: TaxScreens(client: client))
        model.routeDidChange(try #require(NativeRoute(path + "?year=2024")))
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route.value("year") == "2024")
    }

    @Test func portfolioTaxHasNoPortfolioPDFAction() async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let recorder = ShellRecorder()
        let model = makeModel(
            recorder: recorder, portfolio: PortfolioScreens(client: client), tax: TaxScreens(client: client))
        model.routeDidChange(try #require(NativeRoute("/portfolio/tax?year=2024")))
        await model.settingsSettled()
        model.openPortfolioReport()
        #expect(recorder.actions.isEmpty)
        #expect(model.detail == .native(.portfolioTax))
    }

    @Test(arguments: ["/analysis", "/analysis/monitors"])
    func analysisScreensAreNativeWithoutAdminModeAndFallbackWhenOmitted(path: String) async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            analysis: AnalysisScreens(client: client), analysisMonitors: AnalysisMonitorsModel(service: client))
        model.routeDidChange(try #require(NativeRoute(path + "?savedAnalysis=synthetic")))
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route.value("savedAnalysis") == "synthetic")

        let legacy = makeModel(settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder())
        legacy.routeDidChange(try #require(NativeRoute(path)))
        await legacy.settingsSettled()
        #expect(legacy.detail == .web)
    }

    @Test(arguments: [
        "/research", "/research/markets", "/research/market", "/research/watchlist", "/research/compare",
        "/research/forecast", "/research/charts",
        "/research/dossiers", "/ai-chat",
    ])
    func researchScreensPreserveDeepLinksWithoutAdminModeAndFallbackWhenOmitted(path: String) async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            research: ResearchScreens(client: client), researchForecast: ResearchForecastScreens(client: client),
            researchChartBuilder: ResearchChartBuilderModel(client: client, store: ResearchChartLayoutMemoryStore()),
            researchDossiers: ResearchDossiersModel(client: client), aiChat: AIChatScreens(client: client))
        let route = try #require(NativeRoute(path + "?symbol=AAPL&symbol=MSFT&tab=analyst&unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route == route)
        #expect(!model.settings.adminMode)

        let legacy = makeModel(settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder())
        legacy.routeDidChange(route)
        await legacy.settingsSettled()
        #expect(legacy.detail == .web)
    }

    @Test func coveredAIKeepsBothWorkflowDraftsAndActualExitRetiresPageState() async throws {
        let screens = AIChatScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), aiChat: screens)
        let route = try #require(NativeRoute("/ai-chat?mode=investigation&unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        let retainedStreams = screens.chat.streams
        screens.chat.draft = "Synthetic unsent chat"
        screens.investigation.question = "Synthetic investigation"
        model.openSettings()
        model.routeDidChange(route.setting("settings", to: "general"))
        #expect(model.isTemporarilyCovered(route.path))
        #expect(screens.chat.draft == "Synthetic unsent chat")
        #expect(screens.investigation.question == "Synthetic investigation")
        model.routeDidChange(NativeRoute(path: "/research/dossiers"))
        #expect(screens.chat.draft.isEmpty)
        #expect(screens.investigation.question.isEmpty)
        #expect(screens.chat.streams === retainedStreams)
    }

    @Test func coveredDossierRetainsItsEditorWithoutAddingARouteLeaveGuard() async throws {
        let dossiers = ResearchDossiersModel(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), researchDossiers: dossiers)
        let route = NativeRoute(path: "/research/dossiers")
        model.routeDidChange(route)
        await model.settingsSettled()
        await dossiers.didAppear(route: route)
        dossiers.requestNew()
        dossiers.draft?.title = "Synthetic draft"
        #expect(dossiers.hasUnsavedChanges)
        #expect(!model.hasGuardedUnsavedChanges)
        model.openSettings()
        model.routeDidChange(route.setting("settings", to: "general"))
        #expect(model.isTemporarilyCovered(route.path))
        #expect(dossiers.draft?.title == "Synthetic draft")
        model.routeDidChange(NativeRoute(path: "/ai-chat"))
        #expect(dossiers.draft == nil)
        #expect(!model.hasGuardedUnsavedChanges)
    }

    @Test func coveredForecastRetainsInputsAndActualRouteExitResetsTheVisit() async throws {
        let screens = ResearchForecastScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), researchForecast: screens)
        let route = NativeRoute(path: "/research/forecast")
        model.routeDidChange(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        screens.model.contributionText = "250"
        model.openSettings()
        model.routeDidChange(route.setting("settings", to: "general"))
        #expect(model.isTemporarilyCovered(route.path))
        #expect(screens.model.contributionText == "250")
        model.routeDidChange(NativeRoute(path: "/research/charts"))
        #expect(screens.model.contributionText.isEmpty)
        #expect(!model.isTemporarilyCovered(route.path))
    }

    @Test func chartLibrarySurvivesExitAndSharedQueryReplacementKeepsOtherParameters() async throws {
        let recorder = ShellRecorder()
        let charts = ResearchChartBuilderModel(
            client: APIClient(baseURL: { nil }), store: ResearchChartLayoutMemoryStore())
        let model = makeModel(recorder: recorder, researchChartBuilder: charts)
        let route = try #require(NativeRoute("/research/charts?chart=invalid&unrelated=keep"))
        model.routeDidChange(route)
        await model.settingsSettled()
        charts.didReplaceRoute = { model.replaceQuery($0.query) }
        await charts.load(route: route)
        #expect(recorder.actions.last == .replaceRoute("/research/charts?unrelated=keep"))
        charts.addSeries(symbol: "AAPL")
        await charts.flushStorage()
        let savedState = charts.state
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(charts.state == savedState)
        model.routeDidChange(NativeRoute(path: "/research"))
        #expect(charts.state == savedState)
        #expect(!charts.isSearchOpen)
    }

    @Test func webSettingsAndPaletteCoveragePreserveAnalysisDraftUntilARealRouteExit() async throws {
        let screens = AnalysisScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), analysis: screens)
        let route = try #require(NativeRoute("/analysis"))
        model.routeDidChange(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        screens.workspace.name = "Synthetic unsaved query"
        model.openSettings()
        #expect(model.isTemporarilyCovered("/analysis"))
        #expect(!model.isTemporarilyCovered("/research"))
        model.routeDidChange(route.setting("settings", to: "general"))
        #expect(model.isTemporarilyCovered("/analysis"))
        #expect(screens.workspace.name == "Synthetic unsaved query")
        model.routeDidChange(route)
        #expect(!model.isTemporarilyCovered("/analysis"))
        #expect(model.handleKey("k", command: true))
        #expect(model.isTemporarilyCovered("/analysis"))
        model.routeDidChange(try #require(NativeRoute("/research")))
        #expect(screens.workspace.name.isEmpty)
    }

    @Test func coveredLookupRetainsItsDirtyGuardAndActualNavigationRetiresTheVisit() async throws {
        let screens = ResearchScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), research: screens)
        let route = try #require(NativeRoute("/research/market"))
        model.routeDidChange(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        screens.lookup.action.investment.name = "Synthetic unsaved holding"
        model.setLeaveGuard(
            NativeLeaveGuard(
                id: route.path, hasUnsavedChanges: { screens.lookup.action.isDirty },
                discard: { screens.lookup.action.discardDrafts() }))
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(model.hasGuardedUnsavedChanges)
        #expect(screens.lookup.action.investment.name == "Synthetic unsaved holding")
        model.routeDidChange(try #require(NativeRoute("/research/watchlist")))
        #expect(!model.hasGuardedUnsavedChanges)
        #expect(!screens.lookup.action.isDirty)
        #expect(!model.isTemporarilyCovered(route.path))
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
            notices: NativeNoticeCenter(now: { PlannedFixture.today }, automaticExpiry: false),
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
        #expect(
            ExchangeRatesTab(route: NativeRoute(path: "/x", query: [URLQueryItem(name: "tab", value: "bogus")]))
                == .live)
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
