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

private actor ShellInitialSettingsFailure {
    private var hasFailed = false
    func read() throws -> NativeAppSettings {
        if !hasFailed {
            hasFailed = true
            throw APIError.network("synthetic initial read failure")
        }
        return .defaults
    }
}

@MainActor
final class ShellRecorder {
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
        nativeNavigation: NativeNavigationHistory? = nil,
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
            nativeNavigation: nativeNavigation,
            hiddenSections: hidden,
            loadSettings: loadSettings ?? { settings },
            saveHiddenSections: { recorder.saved.append($0) },
            copyToClipboard: {
                guard recorder.acceptsClipboard else { return false }
                recorder.clipboard.append($0)
                return true
            },
            onSidebarVisibilityChange: { recorder.sidebar.append($0) })
    }

    private func makePalette() -> NativeCommandPaletteModel {
        NativeCommandPaletteModel(
            service: APIClient(baseURL: { nil }, adminToken: { nil }),
            answers: NativeCommandPaletteAnswerProvider { _, _, _, _ in nil })
    }

    @Test func startupAndFailureCannotRevealOrPrintCachedNativePage() async throws {
        let history = NativeNavigationHistory(initial: try #require(NativeNavigationLocation("/planned")))
        let model = makeModel(recorder: ShellRecorder(), nativeNavigation: history)
        #expect(model.detail == .loading && model.printDisposition == .unavailable)
        model.reloadSettings()
        await model.settingsSettled()
        #expect(model.detail == .loading)
        model.setNativeDocumentState(.ready)
        #expect(model.detail == .native(.plannedPayments) && model.printDisposition == .nativePage)
        model.isReloadingGraph = true
        #expect(model.detail == .loading && model.printDisposition == .unavailable)
        model.isReloadingGraph = false
        model.setNativeDocumentState(.failed)
        #expect(model.detail == .unavailable && model.printDisposition == .unavailable)
        model.setNativeDocumentState(.loading)
        #expect(model.detail == .loading)
        model.setNativeDocumentState(.ready)
        #expect(model.detail == .native(.plannedPayments))
    }

    @Test func missingOwnersAndUnknownRoutesShowTheNativeFallbacks() async throws {
        let model = makeModel(recorder: ShellRecorder(), nativeNavigation: NativeNavigationHistory())
        model.reloadSettings()
        await model.settingsSettled()
        model.setNativeDocumentState(.ready)
        // The fixture deliberately has no Home, Tax, Settings, or report owner.
        #expect(model.detail == .unavailable)
        for route in ["/tax", "/planned?settings=general", "/planned?export=pdf", "/tax?export=pdf"] {
            model.navigate(to: route)
            #expect(model.detail == .unavailable && model.printDisposition == .unavailable)
        }
        model.navigate(to: "/no-such-route?unrelated=keep")
        #expect(model.detail == .notFound && model.printDisposition == .unavailable)
    }

    @Test func initialSettingsFailureIsNativeAndRetryCanRecover() async throws {
        let script = ShellInitialSettingsFailure()
        let history = NativeNavigationHistory(initial: try #require(NativeNavigationLocation("/planned")))
        let model = makeModel(
            recorder: ShellRecorder(), nativeNavigation: history, loadSettings: { try await script.read() })
        model.setNativeDocumentState(.ready)
        model.reloadSettings()
        await model.settingsSettled()
        #expect(model.detail == .unavailable && model.canRetryInitialSettings)
        #expect(model.printDisposition == .unavailable)
        model.reloadSettings()
        #expect(model.detail == .loading && !model.canRetryInitialSettings)
        await model.settingsSettled()
        #expect(model.detail == .native(.plannedPayments) && !model.canRetryInitialSettings)
    }

    @Test func nativeOverlayPriorityPreservesSettingsRouteAndPaletteCopyAcknowledgement() async throws {
        let recorder = ShellRecorder()
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            recorder: recorder, nativeSettings: NativeSettingsModel(client: client), commandPalette: makePalette())
        let route = try #require(NativeRoute("/planned?settings=general&unrelated=keep"))
        model.show(route)
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
        recorder.acceptsClipboard = false
        model.activatePaletteAction(.copy("123.45"))
        #expect(model.notices.entries.isEmpty && recorder.clipboard.isEmpty)
        recorder.acceptsClipboard = true
        model.activatePaletteAction(.copy("123.45"))
        #expect(recorder.clipboard == ["123.45"])
        #expect(model.notices.entries.last?.notice.key == "commandPalette.copied")
    }

    @Test func reportCloseRemovesOnlyItsQueryAndUnknownRoutesUseTheNativeFallback() async throws {
        let report = NativeReportModel(
            service: ReportTestService(),
            callbacks: NativeReportCallbacks(
                preferences: { .init() }, theme: { .object([:]) }, save: { _, _ in true }, close: {}, notice: { _ in }))
        let model = makeModel(recorder: ShellRecorder(), reports: report)
        model.show(try #require(NativeRoute("/planned?unrelated=keep")))
        await model.settingsSettled()
        model.show(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.isPresented && report.type == .tax)
        #expect(report.periodPreset == .rolling12)
        report.setType(.portfolio)
        report.periodPreset = .year
        report.customYear = "2014"
        report.currency = "JPY"
        model.show(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.type == .portfolio && report.customYear == "2014" && report.currency == "JPY")
        model.closeReport()
        #expect(!report.isPresented)
        #expect(model.nativeNavigationLocation.raw == "/tax?year=2020&unrelated=keep")
        model.show(try #require(NativeRoute("/tax?year=2020&export=pdf&unrelated=keep")))
        #expect(report.type == .portfolio && report.periodPreset == .year && report.currency == "JPY")
        model.show(try #require(NativeRoute("/unknown?unrelated=keep")))
        #expect(model.detail == .notFound)
        model.show(try #require(NativeRoute("/tax?export=pdf")))
        #expect(report.type == .tax && report.periodPreset == .rolling12)
    }

    @Test func pageZoomKeepsSourceBoundsAndReloadFencesNativeShortcutInput() async {
        let model = makeModel(recorder: ShellRecorder(), commandPalette: makePalette())
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
        #expect(model.nativeOverlayKind == nil)
        model.isReloadingGraph = false
        model.openPalette()
        #expect(model.nativeOverlayKind == .palette)
    }

    @Test func theStatisticsReportOpensOnTheSameRouteAndKeepsTheTab() throws {
        let model = makeModel(recorder: ShellRecorder())
        model.show(try #require(NativeRoute("/statistics?tab=yearly&window=all")))
        model.openStatisticsReport()
        #expect(model.nativeNavigationLocation.raw == "/statistics?tab=yearly&window=all&export=pdf")
        model.replaceQuery("export", with: nil)
        #expect(model.route.value("tab") == "yearly" && model.route.value("export") == nil)
    }

    @Test func repeatedSettingsReadsRefreshNativePagesEvenWhenFormatsStayTheSame() {
        let model = makeModel(recorder: ShellRecorder())
        model.apply(settings: .defaults)
        let revision = model.settingsRevision
        model.apply(settings: .defaults)
        #expect(model.settingsRevision == revision + 1)
    }

    @Test func nativeSettingsSectionChangesPreserveTheRouteAndCloseThroughHistory() async throws {
        let preferences = NativeSettingsModel(client: APIClient(baseURL: { nil }, adminToken: { nil }))
        let model = makeModel(recorder: ShellRecorder(), nativeSettings: preferences)
        let route = try #require(NativeRoute("/planned?settings=general&unrelated=keep"))
        model.show(route)
        await model.settingsSettled()
        #expect(model.isPresentingNativeSettings && model.detail == .native(.plannedPayments))
        model.selectSettingsSection("backup")
        #expect(model.nativeNavigationLocation.raw == "/planned?settings=backup&unrelated=keep")
        let location = model.nativeNavigationLocation.raw
        model.selectSettingsSection("unknown")
        #expect(model.nativeNavigationLocation.raw == location)
        model.closeSettings()
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

    @Test func theTaxReportOpensOnTheSameRouteAndKeepsTheYear() throws {
        let model = makeModel(recorder: ShellRecorder())
        model.show(try #require(NativeRoute("/tax?year=2024")))
        model.openTaxReport()
        #expect(model.nativeNavigationLocation.raw == "/tax?year=2024&export=pdf")
        model.replaceQuery("export", with: nil)
        #expect(model.route.value("year") == "2024" && model.route.value("export") == nil)
        #expect(NativeScreen.screen(forPath: "/tax") == .tax)
    }

    @Test(arguments: [
        "/portfolio", "/portfolio/stocks", "/portfolio/crypto", "/portfolio/metals", "/portfolio/real-estate",
        "/portfolio/savings",
    ])
    func portfolioReportPreservesItsOriginAndQueryAndReturnsToNative(path: String) async throws {
        let screens = PortfolioScreens(client: APIClient(baseURL: { nil }, adminToken: { nil }))
        let model = makeModel(recorder: ShellRecorder(), portfolio: screens)
        let original = try #require(NativeRoute(path + "?period=1y&fx_neutral=true"))
        model.show(original)
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        model.openPortfolioReport()
        #expect(model.route == original.setting("export", to: "pdf"))
        model.replaceQuery("export", with: nil)
        #expect(model.route == original)
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
        model.show(try #require(NativeRoute(path + "?year=2024")))
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route.value("year") == "2024")
    }

    @Test func portfolioTaxHasNoPortfolioPDFAction() async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            recorder: ShellRecorder(), portfolio: PortfolioScreens(client: client), tax: TaxScreens(client: client))
        model.show(try #require(NativeRoute("/portfolio/tax?year=2024")))
        await model.settingsSettled()
        let location = model.nativeNavigationLocation.raw
        model.openPortfolioReport()
        #expect(model.nativeNavigationLocation.raw == location)
        #expect(model.detail == .native(.portfolioTax))
    }

    @Test(arguments: ["/analysis", "/analysis/monitors"])
    func analysisScreensAreNativeWithoutAdminModeAndUnavailableWhenOmitted(path: String) async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            analysis: AnalysisScreens(client: client), analysisMonitors: AnalysisMonitorsModel(service: client))
        model.show(try #require(NativeRoute(path + "?savedAnalysis=synthetic")))
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route.value("savedAnalysis") == "synthetic")

        let omitted = makeModel(settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder())
        omitted.show(try #require(NativeRoute(path)))
        await omitted.settingsSettled()
        #expect(omitted.detail == .unavailable)
    }

    @Test(arguments: [
        "/research", "/research/markets", "/research/market", "/research/watchlist", "/research/compare",
        "/research/forecast", "/research/charts",
        "/research/dossiers", "/ai-chat",
    ])
    func researchScreensPreserveDeepLinksWithoutAdminModeAndAreUnavailableWhenOmitted(path: String) async throws {
        let client = APIClient(baseURL: { nil }, adminToken: { nil })
        let model = makeModel(
            settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder(),
            research: ResearchScreens(client: client), researchForecast: ResearchForecastScreens(client: client),
            researchChartBuilder: ResearchChartBuilderModel(client: client, store: ResearchChartLayoutMemoryStore()),
            researchDossiers: ResearchDossiersModel(client: client), aiChat: AIChatScreens(client: client))
        let route = try #require(NativeRoute(path + "?symbol=AAPL&symbol=MSFT&tab=analyst&unrelated=keep"))
        model.show(route)
        await model.settingsSettled()
        #expect(model.detail == .native(try #require(NativeScreen.screen(forPath: path))))
        #expect(model.route == route)
        #expect(!model.settings.adminMode)

        let omitted = makeModel(settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder())
        omitted.show(route)
        await omitted.settingsSettled()
        #expect(omitted.detail == .unavailable)
    }

    @Test func coveredAIKeepsBothWorkflowDraftsAndActualExitRetiresPageState() async throws {
        let screens = AIChatScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), aiChat: screens)
        let route = try #require(NativeRoute("/ai-chat?mode=investigation&unrelated=keep"))
        model.show(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        let retainedStreams = screens.chat.streams
        screens.chat.draft = "Synthetic unsent chat"
        screens.investigation.question = "Synthetic investigation"
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(screens.chat.draft == "Synthetic unsent chat")
        #expect(screens.investigation.question == "Synthetic investigation")
        model.show(NativeRoute(path: "/research/dossiers"))
        #expect(screens.chat.draft.isEmpty)
        #expect(screens.investigation.question.isEmpty)
        #expect(screens.chat.streams === retainedStreams)
    }

    @Test func coveredDossierRetainsItsEditorWithoutAddingARouteLeaveGuard() async throws {
        let dossiers = ResearchDossiersModel(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), researchDossiers: dossiers)
        let route = NativeRoute(path: "/research/dossiers")
        model.show(route)
        await model.settingsSettled()
        await dossiers.didAppear(route: route)
        dossiers.requestNew()
        dossiers.draft?.title = "Synthetic draft"
        #expect(dossiers.hasUnsavedChanges)
        #expect(!model.hasGuardedUnsavedChanges)
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(dossiers.draft?.title == "Synthetic draft")
        model.show(NativeRoute(path: "/ai-chat"))
        #expect(dossiers.draft == nil)
        #expect(!model.hasGuardedUnsavedChanges)
    }

    @Test func coveredForecastRetainsInputsAndActualRouteExitResetsTheVisit() async throws {
        let screens = ResearchForecastScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), researchForecast: screens)
        let route = NativeRoute(path: "/research/forecast")
        model.show(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        screens.model.contributionText = "250"
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(screens.model.contributionText == "250")
        model.show(NativeRoute(path: "/research/charts"))
        #expect(screens.model.contributionText.isEmpty)
        #expect(!model.isTemporarilyCovered(route.path))
    }

    @Test func chartLibrarySurvivesExitAndSharedQueryReplacementKeepsOtherParameters() async throws {
        let charts = ResearchChartBuilderModel(
            client: APIClient(baseURL: { nil }), store: ResearchChartLayoutMemoryStore())
        let model = makeModel(recorder: ShellRecorder(), researchChartBuilder: charts)
        let route = try #require(NativeRoute("/research/charts?chart=invalid&unrelated=keep"))
        model.show(route)
        await model.settingsSettled()
        charts.didReplaceRoute = { model.replaceQuery($0.query) }
        await charts.load(route: route)
        #expect(model.nativeNavigationLocation.raw == "/research/charts?unrelated=keep")
        charts.addSeries(symbol: "AAPL")
        await charts.flushStorage()
        let savedState = charts.state
        model.openSettings()
        #expect(model.isTemporarilyCovered(route.path))
        #expect(charts.state == savedState)
        model.show(NativeRoute(path: "/research"))
        #expect(charts.state == savedState)
        #expect(!charts.isSearchOpen)
    }

    @Test func settingsAndPaletteCoveragePreserveAnalysisDraftUntilARealRouteExit() async throws {
        let screens = AnalysisScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), analysis: screens, commandPalette: makePalette())
        let route = try #require(NativeRoute("/analysis"))
        model.show(route)
        await model.settingsSettled()
        await screens.didAppear(route: route)
        screens.workspace.name = "Synthetic unsaved query"
        model.openSettings()
        #expect(model.isTemporarilyCovered("/analysis"))
        #expect(!model.isTemporarilyCovered("/research"))
        #expect(screens.workspace.name == "Synthetic unsaved query")
        model.closeSettings()
        #expect(!model.isTemporarilyCovered("/analysis"))
        #expect(model.handleKey("k", command: true))
        #expect(model.isTemporarilyCovered("/analysis"))
        await model.closeNativeOverlay()
        model.show(try #require(NativeRoute("/research")))
        #expect(screens.workspace.name.isEmpty)
    }

    @Test func coveredLookupRetainsItsDirtyGuardAndLeavingRetiresTheVisit() async throws {
        let screens = ResearchScreens(client: APIClient(baseURL: { nil }))
        let model = makeModel(recorder: ShellRecorder(), research: screens)
        let route = try #require(NativeRoute("/research/market"))
        model.show(route)
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
        model.closeSettings()
        // The guard holds the navigation until the user leaves.
        model.navigate(to: "/research/watchlist")
        #expect(model.leaveConfirmation?.path == "/research/watchlist" && model.route.path == route.path)
        model.leavePage()
        #expect(model.route.path == "/research/watchlist")
        #expect(!model.hasGuardedUnsavedChanges)
        #expect(!screens.lookup.action.isDirty)
        #expect(!model.isTemporarilyCovered(route.path))
    }

    @Test func theExchangeRatesScreenIsNativeOnlyInAdminMode() async throws {
        let model = makeModel(recorder: ShellRecorder())
        model.show(try #require(NativeRoute("/admin/exchange-rates")))
        // Settings are not known yet: the admin route waits instead of showing.
        #expect(model.detail == .loading)
        await model.settingsSettled()
        #expect(model.settingsLoaded)
        #expect(model.detail == .native(.exchangeRates))
        #expect(model.sections.last?.id == .admin)
        #expect(model.selectedItemURL == "/admin/exchange-rates")
    }

    @Test func withoutAdminModeAnAdminRouteRedirectsHome() async throws {
        let model = makeModel(settings: NativeAppSettings(adminMode: false), recorder: ShellRecorder())
        model.show(try #require(NativeRoute("/admin/exchange-rates?tab=fallback")))
        await model.settingsSettled()
        #expect(model.route == .home)
        #expect(!model.sections.contains { $0.id == .admin })
    }

    @Test func sidebarClicksNavigateAtOnce() throws {
        let model = makeModel(recorder: ShellRecorder())
        #expect(model.route == .home)
        model.navigate(to: "/transactions")
        #expect(model.route.path == "/transactions")
        #expect(model.selectedItemURL == NavigationRegistry.matchItem(path: "/transactions")?.url)
        model.navigate(to: "https://example.com")
        #expect(model.route.path == "/transactions")
    }

    @Test func aQueryValueIsWrittenWithReplace() async throws {
        let model = makeModel(recorder: ShellRecorder())
        model.show(try #require(NativeRoute("/admin/exchange-rates")))
        await model.settingsSettled()
        #expect(model.route.value("tab") == nil)
        let entries = model.nativeNavigation.count
        model.replaceQuery("tab", with: "fallback")
        #expect(model.route.value("tab") == "fallback")
        #expect(model.nativeNavigationLocation.raw == "/admin/exchange-rates?tab=fallback")
        #expect(model.nativeNavigation.count == entries)
    }

    @Test func shortcutsNavigateFromANativeScreen() {
        let model = makeModel(recorder: ShellRecorder())
        let now = Date(timeIntervalSinceReferenceDate: 0)
        #expect(model.handleKey("g", now: now))
        #expect(model.handleKey("t", now: now + 0.1))
        #expect(model.route.path == "/transactions")
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
        model.show(try #require(NativeRoute("/research/markets")))
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
    }

    @Test func settingsApplyTheColorblindSkin() {
        let model = makeModel(recorder: ShellRecorder())
        model.apply(settings: NativeAppSettings(colorblindGainLoss: true))
        #expect(model.theme.colorblindGainLoss)
    }
}
