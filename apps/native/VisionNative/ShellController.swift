import AppKit
import OSLog
import Observation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore
import VisionNativeUI
import WebKit
import os

/// Owns the window, menus, dock and web shell, and answers the page's bridge calls
/// (the main-process side of packaging/electron/main.ts for phases 1c, 1d and 1e). From
/// phase 2 the window shows the native navigation shell (`ShellRootView`) around the web view.
@MainActor
final class ShellController: NSObject, NSWindowDelegate, BridgeHost, AuditShell {
    /// "Vision Native" or "Vision Native Demo" (`APP_NAME`).
    static var appName: String { AppRuntime.variant.appName }
    /// `RENDERER_READY_TIMEOUT_MS` is 12 s in Electron; the page normally calls `ready()`
    /// long before this, and the window shows the web view without it after this delay.
    static let revealFallback: Duration = .seconds(3)

    private let supervisor = AppRuntime.supervisor
    private let logger = AppRuntime.shellLogger
    private let initialSettings: [String: JSONValue]
    private(set) var strings: ShellStrings
    private var palette: LaunchPalette
    private let launchModel: LaunchModel
    private let menuController = MenuController()
    private let settingsTransport: URLSessionSettingsTransport
    private var settingsWriter: SettingsWriter
    private let backupService: BackupService
    /// The six `electronAudit` channels, the closure timer and the audit notices.
    private lazy var auditChannels = makeAuditChannels()
    /// The typed API client of native screens (`client.ts`).
    private lazy var apiClient = makeAPIClient()
    private var dataSession = NativeDataSession()
    private var localStateSession = NativeLocalStateSession()
    private var restoreFenceEntered = false
    private var restoreFenceOwner: UUID?
    private var restoredNativeGeneration: UUID?
    /// Accepted restore retains its source workflow until frontend state and the
    /// onboarding receipt are applied, then performs the source delayed reload.
    private var pendingRestoreReload: UUID?
    /// Fresh restore-only storage authority; old graph admission is already retired.
    private var restoredFrontendSession: NativeLocalStateSession?
    private var restoredCompletionDataSession: NativeDataSession?
    private var onboardingRestoreIntent: UUID?
    private var nativeSettingsRebuildTask: Task<Void, any Error>?
    private var manualReloadTask: Task<Bool, Never>?
    private var isPrintingCurrentPage = false
    /// The sidebar, route and settings state of the native navigation shell.
    private lazy var shellModel = makeShellModel()
    /// `ALLOWED_RESTORE_PATHS`: only paths the restore picker returned may be restored.
    private(set) var restorePathAllowList = RestorePathAllowList()
    private(set) var window: NSWindow?
    private var container: NSView?
    private var effectView: NSVisualEffectView?
    private var launchView: NSHostingView<LaunchStateView>?
    private var webShell: WebShell?
    /// The SwiftUI shell (sidebar and detail) that hosts the web view.
    private var shellHost: NSView?
    /// The backend base URL the web view may show; `nil` until the runtime is ready.
    private(set) var appURL: URL?
    /// Fixed once, before the first document and shell graph are created (ADR-207).
    private(set) var documentSelection = NativeHelperDocumentSelection.retainedWeb
    /// The helper document authority of the current graph generation, in helper mode only.
    private var helperSession: NativeHelperDocumentSession?
    private var helperBootstrapTask: Task<Void, Never>?
    /// The language the current helper document was last told, by bootstrap or locale command.
    private var helperLanguage: NativeHelperDocumentBridge.Language?
    private var hasMadeShellModel = false
    private var healthWatchdogTask: Task<Void, Never>?
    private let backendNoticeSource = UUID()
    private var backendNoticeID: UUID?
    /// Helper mode only: cold CSV, new-transaction and menu intents, retained across graph
    /// rebuilds so committed history and unconsumed intents survive (ADR-207).
    private let nativeIntents = NativeShellIntentCoordinator()
    /// The first helper startup seeds a new session; later documents are reloads.
    private var helperStartupResolved = false
    private var queue = RendererMessageQueue()
    private var rendererReadiness = NativeRendererReadiness()
    private var launchTask: Task<Void, Never>?
    private var pageLoadTask: Task<Void, Never>?
    private var revealTask: Task<Void, Never>?
    private var frameSaveTask: Task<Void, Never>?
    private var languageRequest = 0
    private var accentObserver: NSObjectProtocol?
    private var appearanceObserver: NSKeyValueObservation?
    private var nativeSettingsGeneration = UUID()
    private var nativeSettingsDrafts: [String: TaxValue] = [:]
    private var settingsAppearanceTask: Task<Void, Never>?
    private var lastSettingsClockRefresh = Date.distantPast
    private var lastSettingsDisplayPixels: Double?
    private var lastSettingsSystemIsDark: Bool?

    private func makeAuditChannels() -> AuditChannels {
        AuditChannels(
            runtimeProvider: { await AppRuntime.supervisor.auditRuntime() }, shell: self,
            log: { message in AppRuntime.shellLogger.warning("\(message, privacy: .public)") })
    }

    private func makeAPIClient(session: NativeDataSession? = nil, timeout: TimeInterval = 30) -> APIClient {
        let transport = URLSessionAPITransport()
        let fenced = NativeSessionAPITransport(base: transport, streamBase: transport, session: session ?? dataSession)
        return APIClient(
            baseURL: { [weak self] in await self?.appURL },
            adminToken: { [weak self] in await self?.adminToken() },
            transport: fenced, timeout: timeout, streamTransport: fenced)
    }

    private func makeShellModel(initialRoute: NativeRoute = .home) -> NativeShellModel {
        hasMadeShellModel = true
        let client = apiClient
        let settingsGeneration = UUID()
        nativeSettingsGeneration = settingsGeneration
        let nativeSettings = NativeSettingsModel(client: client)
        let settingsAI = NativeSettingsAIModel(service: client)
        let desktopSettings = makeNativeSettingsDesktopCallbacks(generation: settingsGeneration)
        let settingsBackup = NativeSettingsBackupModel(service: desktopSettings)
        let commandPalette = NativeCommandPaletteModel(
            service: client,
            answers: NativeCommandPaletteAnswerProvider { [weak self] query, format, currency, decimals in
                guard let self else { throw APIError.backendUnavailable }
                return try await self.nativePaletteAnswer(
                    query: query, format: format, currency: currency, decimals: decimals,
                    generation: settingsGeneration)
            },
            readRecents: { [weak self] in
                guard let self else { throw APIError.backendUnavailable }
                return try await self.nativeLocalValue(.paletteRecents, generation: settingsGeneration)
            },
            writeRecents: { [weak self] value in
                guard let self else { throw APIError.backendUnavailable }
                try await self.writeNativeLocalValue(value, key: .paletteRecents, generation: settingsGeneration)
            })
        let notifications = NativeShellNotificationsModel(
            client: client,
            storage: NativeShellNotificationStorage(
                read: { [weak self] key in
                    guard let self else { throw APIError.backendUnavailable }
                    return try await self.nativeLocalValue(
                        key == .fxDismissedAt ? .fxDismissedAt : .upcomingDismissals,
                        generation: settingsGeneration)
                },
                write: { [weak self] key, value in
                    guard let self else { throw APIError.backendUnavailable }
                    try await self.writeNativeLocalValue(
                        value, key: key == .fxDismissedAt ? .fxDismissedAt : .upcomingDismissals,
                        generation: settingsGeneration)
                }))
        let onboarding = NativeOnboardingModel(
            service: client, persistence: nativeSettings.persistence,
            store: NativeOnboardingDraftCallbacks(
                read: { [weak self] in
                    guard let self else { throw APIError.backendUnavailable }
                    return try await self.nativeLocalValue(.onboardingDraft, generation: settingsGeneration)
                        .map { Data($0.utf8) }
                },
                write: { [weak self] data in
                    guard let self else { throw APIError.backendUnavailable }
                    try await self.writeNativeLocalValue(
                        String(decoding: data, as: UTF8.self), key: .onboardingDraft,
                        generation: settingsGeneration)
                },
                remove: { [weak self] in
                    guard let self else { throw APIError.backendUnavailable }
                    try await self.writeNativeLocalValue(nil, key: .onboardingDraft, generation: settingsGeneration)
                }), desktop: makeNativeSettingsDesktopCallbacks(generation: settingsGeneration, onboardingRestore: true)
        )
        onboarding.completeAfterRestore = { [weak self] in
            guard let self else { throw APIError.backendUnavailable }
            try await self.completeNativeOnboardingAfterRestore(generation: settingsGeneration)
        }
        let reportNoticeSource = UUID()
        let reports = NativeReportModel(
            service: NativeReportsAPIService(client: makeAPIClient(timeout: 900)),
            callbacks: NativeReportCallbacks(
                preferences: { [weak nativeSettings] in
                    guard let nativeSettings else { return .init() }
                    return .init(
                        currency: nativeSettings.appString("defaultCurrency", fallback: "EUR"),
                        exclusionScope: nativeSettings.dashboardString("exclusionScope", fallback: "everywhere"),
                        excludedCategoryIds: nativeSettings.excludedCategoryIds,
                        excludedRecipientIds: nativeSettings.excludedRecipientIds)
                },
                theme: { [weak self] in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else {
                        throw CancellationError()
                    }
                    return self.nativeReportTheme()
                },
                taxContext: { [weak self] year in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else {
                        throw CancellationError()
                    }
                    return try await self.nativeTaxReportContext(year: year, generation: settingsGeneration)
                },
                save: { [weak self] data, name in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else { return false }
                    return try await self.saveExport(data, suggestedName: name)
                },
                print: { [weak self] data, name in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else { return false }
                    return self.printNativeReport(data, name: name)
                },
                close: { [weak self] in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
                    self.shellModel.closeReport()
                },
                notice: { [weak self] notice in
                    guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
                    self.shellModel.notices.publish(notice, source: reportNoticeSource)
                }))
        let settingsAbout = NativeSettingsAboutModel(
            service: makeNativeSettingsDesktopCallbacks(generation: settingsGeneration, restoreReload: false),
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
            appName: Self.appName)
        nativeSettings.loadKeepServices = { [weak self] in
            guard let self else { throw APIError.backendUnavailable }
            return await self.loadServicesSettings()
        }
        nativeSettings.saveKeepServices = { [weak self] keep in
            guard let self else { throw APIError.backendUnavailable }
            try await self.saveServicesSettings(keepServicesOnQuit: keep)
        }
        nativeSettings.clearRecurringLocalState = { [weak self] in
            _ = try? await self?.writeNativeLocalValue(nil, key: .recurringDismissals, generation: settingsGeneration)
        }
        nativeSettings.didChangeApp = { [weak self, weak settingsAI, weak commandPalette] raw in
            guard let self, self.nativeSettingsGeneration == settingsGeneration,
                let projected = try? JSONValue(encoding: raw)
            else { return }
            let settings = NativeAppSettings.migrate(projected)
            self.shellModel.apply(settings: settings)
            settingsAI?.configure(appRaw: raw)
            commandPalette?.configure(settings: settings)
            self.publishNativeSettings(kind: "draft", key: "app_settings", value: raw)
            self.resolveNativeSettingsAppearance()
            if let language = NativeLanguage(rawValue: settings.language) {
                Task { [weak self] in _ = await self?.setLanguage(language) }
            }
        }
        nativeSettings.didChangeDashboard = { [weak self] raw in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            self.publishNativeSettings(kind: "draft", key: "dashboard_settings", value: raw)
        }
        nativeSettings.didChangeTheme = { [weak self] raw in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            self.publishNativeSettings(kind: "draft", key: "theme_settings", value: raw)
            self.resolveNativeSettingsAppearance()
        }
        nativeSettings.didAcknowledge = { [weak self] key, value in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            self.publishNativeSettings(kind: "ack", key: key, value: value)
            self.shellModel.nativeSettingsDidAcknowledge(key, value: value)
        }
        nativeSettings.didResetPreferences = { [weak self] in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            await self.shellModel.nativePreferencesDidReset()
        }
        settingsAbout.onOpenExternal = { url in NSWorkspace.shared.open(url) }
        settingsAbout.onRestartOnboarding = { [weak self, weak nativeSettings] in
            guard let self, let nativeSettings, self.nativeSettingsGeneration == settingsGeneration else {
                throw APIError.backendUnavailable
            }
            _ = try await nativeSettings.persistence.save("onboarding_complete", value: .bool(false))
            try await self.writeNativeLocalValue(nil, key: .onboardingDraft, generation: settingsGeneration)
            self.shellModel.closeSettings()
        }
        let systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        // The rates page and the planned payments page share one rates cache, like the web's
        // shared query key.
        let rates = ExchangeRatesModel(service: client)
        let imports = ImportsModel(service: client, exports: client, review: client, pickers: client)
        // `downloadBlob`: the export asks where to save, under the web's file name.
        imports.export.save = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        let transactions = TransactionsModel(
            service: client, attachments: client, pickers: client, bulk: client, splits: client)
        // The filter banner's and the bulk bar's exports and the attachment downloads ask
        // where to save.
        transactions.save = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        // `/owes`' Export CSV.
        transactions.owes.save = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        let tax = TaxScreens(client: client)
        let analysis = AnalysisScreens(
            client: client,
            sqlRead: { [weak self] in
                guard
                    let value = await self?.homeLocalStorage(
                        key: "vision.analysis.sqlHistory", generation: settingsGeneration), value != .null
                else {
                    return nil
                }
                return try? value.serialized()
            },
            sqlWrite: { [weak self] data in
                guard let value = try? JSONValue.parse(data) else { return }
                _ = await self?.homeLocalStorage(
                    key: "vision.analysis.sqlHistory", value: value, generation: settingsGeneration)
            })
        let analysisMonitors = AnalysisMonitorsModel(service: client)
        let research = ResearchScreens(client: client)
        let researchForecast = ResearchForecastScreens(client: client)
        let researchCharts = ResearchChartBuilderModel(
            client: client,
            store: ResearchChartLayoutClosureStore(
                read: { [weak self] in
                    guard let self else { throw APIError.backendUnavailable }
                    return try await self.readChartLayouts(generation: settingsGeneration)
                },
                write: { [weak self] data in
                    await self?.writeChartLayouts(data, generation: settingsGeneration) ?? false
                }))
        researchCharts.shareOrigin = { [weak self] in
            guard let url = self?.appURL, var origin = URLComponents(url: url, resolvingAgainstBaseURL: false),
                origin.scheme != nil, origin.host != nil
            else { throw APIError.backendUnavailable }
            origin.path = ""
            origin.query = nil
            origin.fragment = nil
            origin.user = nil
            origin.password = nil
            guard let value = origin.string else { throw APIError.backendUnavailable }
            return value
        }
        researchCharts.copyText = { value in
            NSPasteboard.general.clearContents()
            guard NSPasteboard.general.setString(value, forType: .string) else {
                throw APIError.invalidRequest("Clipboard write failed")
            }
        }
        researchCharts.didReplaceRoute = { [weak self] route in
            guard let self, self.shellModel.route.path == route.path else { return }
            self.shellModel.replaceQuery(route.query)
        }
        let dossiers = ResearchDossiersModel(client: client)
        dossiers.saveExport = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        dossiers.didMutate = { [weak self, weak analysisMonitors] in
            analysisMonitors?.invalidate()
            if self?.shellModel.route.path == "/analysis/monitors" { await analysisMonitors?.load(force: true) }
        }
        let aiChat = AIChatScreens(client: client)
        bindNativeSettingsAI(settingsAI, chat: aiChat)
        aiChat.chat.didReplaceRoute = { [weak self] route in
            guard let self, self.shellModel.route.path == route.path else { return }
            self.shellModel.replaceQuery(route.query)
        }
        aiChat.investigation.pickDocument = { [weak self] in
            guard let self else { return nil }
            return try await self.pickResearchDocument()
        }
        research.didMutatePortfolio = { [weak self] in await self?.shellModel.portfolioDataDidMutate() }
        analysis.workspace.saveExport = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        analysis.didMutate = { [weak self, weak analysisMonitors] in
            analysisMonitors?.invalidate()
            if self?.shellModel.route.path == "/analysis/monitors" { await analysisMonitors?.load(force: true) }
        }
        let portfolio = PortfolioScreens(client: client)
        research.lookup.action.brokerContext = { [weak portfolio] investmentId in
            guard let portfolio else { return ResearchMarketBrokerContext(accounts: [], preferredBrokerId: nil) }
            if let investments = try? await client.researchInvestments() {
                portfolio.editing.bindInvestments(investments)
            }
            await portfolio.editing.loadOptions()
            return ResearchMarketBrokerContext(
                accounts: portfolio.editing.brokers,
                preferredBrokerId: portfolio.editing.preferredBrokerId(investmentId: investmentId))
        }
        let portfolioImports = PortfolioImportScreens(
            service: client,
            store: PortfolioImportClosureSessionStore(
                read: { [weak self] key in
                    guard let value = await self?.portfolioSessionStorage(key: key, generation: settingsGeneration),
                        value != .null
                    else { return nil }
                    return try? value.serialized()
                },
                write: { [weak self] key, data in
                    guard let value = data.flatMap({ try? JSONValue.parse($0) }) ?? (data == nil ? .null : nil) else {
                        return
                    }
                    _ = await self?.portfolioSessionStorage(key: key, value: value, generation: settingsGeneration)
                }))
        portfolioImports.didMutate = { [weak self] in
            await self?.shellModel.portfolioImportDidMutate()
        }
        portfolioImports.navigateToReview = { [weak self] batchId in
            self?.shellModel.navigate(to: "/portfolio/import/\(batchId)/review")
        }
        tax.didInvalidate = { [weak portfolio] in portfolio?.tax.invalidate() }
        portfolio.tax.didSave = { [weak tax, weak portfolio] in
            tax?.invalidate()
            portfolio?.dataDidChange()
        }
        tax.save = { [weak self] data, name in
            guard let self else { return false }
            return try await self.saveExport(data, suggestedName: name)
        }
        tax.deductions.bindStorage(
            read: { [weak self] key in
                guard let value = await self?.homeLocalStorage(key: key, generation: settingsGeneration) else {
                    return nil
                }
                return try? String(data: value.serialized(), encoding: .utf8)
            },
            write: { [weak self] key, raw in
                guard let value = try? JSONValue.parse(Data(raw.utf8)) else { return }
                _ = await self?.homeLocalStorage(key: key, value: value, generation: settingsGeneration)
            })
        let model = NativeShellModel(
            strings: CatalogStrings(language: strings.language),
            theme: ThemeSelection.resolve(
                splashTheme: LaunchAppearance.theme(fromSettings: initialSettings), systemIsDark: systemIsDark),
            exchangeRates: rates,
            admin: AdminScreens.make(
                service: client, database: client, token: makeAdminTokenAccess(generation: settingsGeneration),
                audit: auditChannels),
            planned: PlannedPaymentsModel(service: client, editing: client, pickers: client, rates: rates),
            imports: imports,
            transactions: transactions,
            // `/accounts` converts its subtotals with the same shared rates cache.
            accounts: AccountsModel(service: client, rates: rates),
            categories: CategoriesModel(service: client),
            recipients: RecipientsModel(service: client),
            home: HomeModel(
                service: client,
                readLocal: { [weak self] key in
                    await self?.homeLocalStorage(key: key, generation: settingsGeneration)
                },
                writeLocal: { [weak self] key, value in
                    _ = await self?.homeLocalStorage(key: key, value: value, generation: settingsGeneration)
                }),
            statistics: StatisticsScreens(client: client),
            tax: tax,
            portfolio: portfolio,
            portfolioImports: portfolioImports,
            analysis: analysis,
            analysisMonitors: analysisMonitors,
            research: research,
            researchForecast: researchForecast,
            researchChartBuilder: researchCharts,
            researchDossiers: dossiers,
            aiChat: aiChat,
            nativeSettings: nativeSettings,
            settingsAI: settingsAI,
            settingsBackup: settingsBackup,
            settingsAbout: settingsAbout,
            commandPalette: commandPalette,
            shellNotifications: notifications,
            onboarding: onboarding,
            reports: reports,
            nativeFallback: true,
            presentationMode: documentSelection.presentationMode,
            initialRoute: initialRoute,
            // The helper document has no router: native history owns every route (ADR-206).
            nativeNavigation: documentSelection == .retainedWeb
                ? nil : NativeNavigationHistory(initial: NativeNavigationLocation(initialRoute.string) ?? .home),
            nativeIntents: documentSelection == .retainedWeb ? nil : nativeIntents,
            hiddenSections: Self.loadHiddenSections(),
            loadSettings: {
                await nativeSettings.load()
                return try await MainActor.run {
                    guard nativeSettings.isLoaded else { throw APIError.backendUnavailable }
                    return NativeAppSettings.migrate(try JSONValue(encoding: nativeSettings.appRaw ?? .object([:])))
                }
            },
            saveHiddenSections: { Self.saveHiddenSections($0) },
            onNavigate: { [weak self] action in
                self?.sendToApp(.menuAction, BridgeDispatcher.menuActionPayload(action))
            },
            copyToClipboard: { value in
                NSPasteboard.general.clearContents()
                return NSPasteboard.general.setString(value, forType: .string)
            },
            onSidebarVisibilityChange: { [weak self] visible in
                self?.deliver(.menuAction, BridgeDispatcher.menuActionPayload(.nativeSidebar(visible: visible)))
            })
        model.sidebarBadges = NativeSidebarBadgesModel(service: client)
        model.isEditingWebText = { [weak self] in
            guard let self else { return true }
            return (try? await self.nativeSettingsScript(NativeSettingsStorageBridge.editingScript))?.boolValue ?? true
        }
        // The renderer startup callback publishes readiness only after verifying
        // the incoming document and this graph's generation.
        model.isRendererReady = false
        model.setPageZoom(Double(webShell?.webView.pageZoom ?? 1))
        model.home?.useSharedUpcoming()
        notifications.upcoming.didLoadUpcoming = { [weak model] rows in
            model?.home?.applySharedUpcoming(rows)
        }
        notifications.upcoming.didChangeDismissals = { [weak model] keys in
            model?.home?.applyUpcomingDismissals(keys)
        }
        if let rows = notifications.upcoming.upcoming { model.home?.applySharedUpcoming(rows) }
        model.home?.applyUpcomingDismissals(notifications.upcoming.dismissalKeys)
        notifications.upcoming.didChangeDockBadge = { [weak self] count in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            self.setDockBadge(count)
        }
        notifications.fx.didRefreshRates = { [weak model] in
            model?.exchangeRatesDidRefresh()
            if let model, model.route.path == "/admin/exchange-rates" { await model.exchangeRates.retry() }
        }
        model.exchangeRates.didRefreshRates = { [weak self, weak model, weak notifications] in
            guard let self, (try? self.requireNativeGeneration(settingsGeneration)) != nil else { return }
            model?.exchangeRatesDidRefresh()
            notifications?.fx.invalidate()
            await notifications?.fx.refreshIfStale()
        }
        onboarding.requestDashboardArrival = { [weak self] in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            Task { [weak self] in
                guard let self else { return }
                guard (try? self.requireNativeGeneration(settingsGeneration)) != nil else { return }
                _ = try? await self.nativeFrontendMutationScript(
                    """
                    try { window.sessionStorage.removeItem('vision.dashboardArrivalSeen'); } catch {}
                    window.dispatchEvent(new Event('vision:dashboard-arrival'));
                    return true;
                    """, generation: settingsGeneration)
            }
        }
        observeNativeSettingsSession(model: model, generation: settingsGeneration)
        observeNativeOnboarding(model: onboarding, generation: settingsGeneration)
        return model
    }

    private func requireNativeGeneration(_ generation: UUID, allowRestored: Bool = false) throws {
        guard generation == nativeSettingsGeneration,
            allowRestored || restoredNativeGeneration != generation
        else { throw CancellationError() }
    }

    private func nativeLocalValue(_ key: NativeSettingsStorageBridge.LocalKey, generation: UUID) async throws -> String?
    {
        try requireNativeGeneration(generation)
        let session = localStateSession
        try await session.checkRead()
        guard queue.isReady else { throw CancellationError() }
        let result: JSONValue
        do {
            result = try await nativeSettingsScript(
                NativeSettingsStorageBridge.readScript, arguments: NativeSettingsStorageBridge.arguments(for: key))
        } catch {
            guard queue.isReady else { throw CancellationError() }
            throw error
        }
        guard queue.isReady else { throw CancellationError() }
        try requireNativeGeneration(generation)
        try await session.checkRead()
        return try NativeSettingsStorageBridge.readLocalReply(result)
    }

    private func writeNativeLocalValue(
        _ value: String?, key: NativeSettingsStorageBridge.LocalKey, generation: UUID, allowRestored: Bool = false
    ) async throws {
        try requireNativeGeneration(generation, allowRestored: allowRestored)
        let script = value == nil ? NativeSettingsStorageBridge.removeScript : NativeSettingsStorageBridge.writeScript
        let arguments = NativeSettingsStorageBridge.arguments(for: key, value: value)
        let result: JSONValue
        if allowRestored {
            result = try await restoredFrontendMutationScript(script, arguments: arguments, generation: generation)
        } else {
            let session = localStateSession
            let token = try await session.beginWrite()
            do {
                try Task.checkCancellation()
                try requireNativeGeneration(generation)
            } catch {
                await session.finishWrite(token)
                throw error
            }
            result = try await nativeSettingsScript(
                script, arguments: arguments,
                didCompleteActual: { Task { await session.finishWrite(token) } })
        }
        try requireNativeGeneration(generation, allowRestored: allowRestored)
        guard try NativeSettingsStorageBridge.mutationReply(result) else { throw APIError.backendUnavailable }
    }

    private func restoredFrontendMutationScript(
        _ script: String, arguments: [String: JSONValue], generation: UUID
    ) async throws -> JSONValue {
        guard generation == nativeSettingsGeneration, pendingRestoreReload == generation,
            let session = restoredFrontendSession
        else { throw CancellationError() }
        let token = try await session.beginWrite()
        guard generation == nativeSettingsGeneration, pendingRestoreReload == generation else {
            await session.finishWrite(token)
            throw CancellationError()
        }
        return try await nativeSettingsScript(
            script, arguments: arguments, didCompleteActual: { Task { await session.finishWrite(token) } })
    }

    private func beginNativeStorageWrite() async throws -> (NativeLocalStateSession, UUID) {
        let session = localStateSession
        let token = try await session.beginWrite()
        do { try Task.checkCancellation() } catch {
            await session.finishWrite(token)
            throw error
        }
        return (session, token)
    }

    private func nativeFrontendMutationScript(
        _ script: String, arguments: [String: JSONValue] = [:], generation: UUID
    ) async throws -> JSONValue {
        try requireNativeGeneration(generation)
        let (session, token) = try await beginNativeStorageWrite()
        do { try requireNativeGeneration(generation) } catch {
            await session.finishWrite(token)
            throw error
        }
        let result = try await nativeSettingsScript(
            script, arguments: arguments, didCompleteActual: { Task { await session.finishWrite(token) } })
        try requireNativeGeneration(generation)
        return result
    }

    private func nativePaletteAnswer(
        query: String, format: NumberFormat, currency: String, decimals: Int, generation: UUID
    ) async throws -> NativeCommandPaletteAnswer? {
        try requireNativeGeneration(generation)
        let reply = try await nativeSettingsScript(
            """
            if (typeof window.__visionNativePaletteAnswer !== 'function') return null;
            return await window.__visionNativePaletteAnswer(query, numberFormat, currency, decimals);
            """,
            arguments: [
                "query": .string(query), "numberFormat": .string(format.rawValue), "currency": .string(currency),
                "decimals": .int(decimals),
            ])
        try requireNativeGeneration(generation)
        if reply == .null { return nil }
        guard let fields = reply.objectValue, Set(fields.keys) == ["kind", "text"],
            let raw = fields["kind"]?.stringValue,
            let kind = NativeCommandPaletteAnswer.Kind(rawValue: raw), let text = fields["text"]?.stringValue
        else { throw APIError.invalidRequest("Invalid palette answer") }
        return .init(kind: kind, text: text)
    }

    private func nativeReportTheme() -> TaxValue {
        let theme = shellModel.theme
        let palette = theme.palette
        func hsl(_ color: HSLColor) -> TaxValue {
            func part(_ value: Double) -> String {
                String(format: "%g", locale: Locale(identifier: "en_US_POSIX"), value)
            }
            return .string("\(part(color.hue)) \(part(color.saturation))% \(part(color.lightness))%")
        }
        return .object([
            "mode": .string(theme.appearance.rawValue), "primary": hsl(theme.primary), "accent": hsl(palette.accent),
            "success": hsl(palette.success), "expense": hsl(palette.expense), "surface": hsl(palette.background),
            "text": hsl(palette.foreground), "muted": hsl(palette.mutedForeground), "border": hsl(palette.border),
            "chart1": hsl(palette.chart1), "chart2": hsl(palette.chart2), "chart3": hsl(palette.chart3),
            "chart4": hsl(palette.chart4), "chart5": hsl(palette.chart5), "chart6": hsl(palette.chart6),
            "chart7": hsl(palette.chart7), "chart8": hsl(palette.chart8),
        ])
    }

    private func nativeTaxReportContext(year: Int, generation: UUID) async throws -> TaxValue {
        try requireNativeGeneration(generation)
        let context = NativeTaxReportContextService(
            client: apiClient,
            localize: { [weak self] key in self?.shellModel.strings.t(key) ?? key },
            projectProfile: { [weak self] household, year in
                guard let self else { throw APIError.backendUnavailable }
                try self.requireNativeGeneration(generation)
                let householdJSON = String(decoding: try JSONEncoder().encode(household), as: UTF8.self)
                let reply = try await self.nativeSettingsScript(
                    """
                    if (typeof window.__visionNativeTaxReportProfile !== 'function') throw new Error('Tax report profile unavailable');
                    return await window.__visionNativeTaxReportProfile(householdJSON, year);
                    """, arguments: ["householdJSON": .string(householdJSON), "year": .int(year)])
                try self.requireNativeGeneration(generation)
                return try JSONDecoder().decode(TaxValue.self, from: JSONEncoder().encode(reply))
            },
            sourceContext: { [weak self] settings, year in
                guard let self else { throw APIError.backendUnavailable }
                try self.requireNativeGeneration(generation)
                let settingsJSON = String(decoding: try JSONEncoder().encode(settings), as: UTF8.self)
                let reply = try await self.nativeSettingsScript(
                    """
                    if (typeof window.__visionNativeTaxReportContext !== 'function') throw new Error('Tax report context unavailable');
                    return await window.__visionNativeTaxReportContext(settingsJSON, year);
                    """, arguments: ["settingsJSON": .string(settingsJSON), "year": .int(year)])
                try self.requireNativeGeneration(generation)
                return try JSONDecoder().decode(TaxValue.self, from: JSONEncoder().encode(reply))
            })
        let value = try await context.context(year: year)
        try requireNativeGeneration(generation)
        return value
    }

    private func printNativeReport(_ data: Data, name: String) -> Bool {
        guard let document = PDFDocument(data: data),
            let operation = document.printOperation(
                for: NSPrintInfo.shared, scalingMode: .pageScaleDownToFit, autoRotate: true)
        else { return false }
        operation.jobTitle = name
        operation.showsPrintPanel = true
        operation.showsProgressPanel = true
        return operation.run()
    }

    private func completeNativeOnboardingAfterRestore(generation: UUID) async throws {
        guard onboardingRestoreIntent == generation, generation == nativeSettingsGeneration,
            let completionSession = restoredCompletionDataSession
        else { throw CancellationError() }
        let currentGeneration = generation
        let persistence = NativeSettingsPersistence(service: makeAPIClient(session: completionSession))
        let record = try await persistence.read("onboarding_complete")
        guard onboardingRestoreIntent == generation, currentGeneration == nativeSettingsGeneration else {
            throw CancellationError()
        }
        if record.value != .bool(true) { _ = try await persistence.save("onboarding_complete", value: .bool(true)) }
        guard onboardingRestoreIntent == generation, currentGeneration == nativeSettingsGeneration else {
            throw CancellationError()
        }
        // The source's draft clear is best effort after the acknowledged completion.
        try? await writeNativeLocalValue(nil, key: .onboardingDraft, generation: currentGeneration, allowRestored: true)
        try? await applyNativeOnboardingState(
            complete: .bool(true), presented: false, generation: currentGeneration, restored: true)
        onboardingRestoreIntent = nil
    }

    private func observeNativeOnboarding(model: NativeOnboardingModel, generation: UUID) {
        withObservationTracking {
            _ = model.isLoaded
            _ = model.isLoading
            _ = model.isPresented
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model, generation == self.nativeSettingsGeneration else { return }
                if !self.restoreFenceEntered, self.restoredNativeGeneration != generation {
                    self.publishNativeOnboarding(model: model, generation: generation)
                }
                self.observeNativeOnboarding(model: model, generation: generation)
            }
        }
    }

    private func publishNativeOnboarding(model: NativeOnboardingModel, generation: UUID) {
        let complete: JSONValue = model.isLoaded && !model.isLoading ? .bool(!model.isPresented) : .null
        publishNativeOnboardingState(complete: complete, presented: model.isPresented, generation: generation)
    }

    private func publishNativeOnboardingState(
        complete: JSONValue, presented: Bool, generation: UUID, restored: Bool = false
    ) {
        Task { [weak self] in
            try? await self?.applyNativeOnboardingState(
                complete: complete, presented: presented, generation: generation, restored: restored)
        }
    }

    private func applyNativeOnboardingState(
        complete: JSONValue, presented: Bool, generation: UUID, restored: Bool = false
    ) async throws {
        guard generation == nativeSettingsGeneration, queue.isReady else { throw CancellationError() }
        let state: JSONValue = .object(["complete": complete, "presented": .bool(presented)])
        let script = """
            const current = window.__VISION_NATIVE_ONBOARDING_STATE__;
            if (current && typeof current === 'object') Object.assign(current, state);
            window.dispatchEvent(new CustomEvent('vision:native-onboarding', {detail: state}));
            return true;
            """
        if restored {
            _ = try await restoredFrontendMutationScript(
                script, arguments: ["state": state], generation: generation)
        } else {
            _ = try await nativeFrontendMutationScript(script, arguments: ["state": state], generation: generation)
        }
    }

    private func makeNativeSettingsDesktopCallbacks(
        generation: UUID, restoreReload: Bool = true, onboardingRestore: Bool = false
    ) -> NativeSettingsDesktopCallbacks {
        NativeSettingsDesktopCallbacks(
            loadBackupSettings: { [weak self] in
                guard let self else { throw APIError.backendUnavailable }
                return await self.loadBackupSettings()
            },
            saveBackupSettings: { [weak self] value in
                guard let self else { throw APIError.backendUnavailable }
                try await self.saveBackupSettings(value)
            },
            selectBackupDirectory: { [weak self] in await self?.selectBackupDirectory() },
            selectBackupFile: { [weak self] in await self?.selectRestoreFile() },
            backupEncryptionStatus: { [weak self] in await self?.backupEncryptionStatus() },
            setBackupPassphrase: { [weak self] value in await self?.setBackupPassphrase(value) },
            captureFrontendState: { [weak self] in
                guard let self else { return nil }
                return try NativeSettingsStorageBridge.readReply(
                    try await self.nativeSettingsScript(NativeSettingsStorageBridge.exportScript))
            },
            runBackup: { [weak self] directory, state in
                await self?.runBackup(destination: directory, frontendStateJson: state)
            },
            isBackupEncrypted: { [weak self] path in await self?.isBackupEncrypted(path) ?? false },
            restoreBackup: { [weak self] path, passphrase in
                guard let self else { return nil }
                try self.requireNativeGeneration(generation)
                return await self.restoreNativeBackup(
                    path, passphrase: passphrase, onboardingRestore: onboardingRestore, nativeReloadOwned: true)
            },
            applyRestoredFrontendState: { [weak self] state in
                guard let self else { throw APIError.backendUnavailable }
                guard self.pendingRestoreReload == generation, generation == self.nativeSettingsGeneration else {
                    throw CancellationError()
                }
                let result = try await self.restoredFrontendMutationScript(
                    NativeSettingsStorageBridge.restoreScript,
                    arguments: NativeSettingsStorageBridge.restoreArguments(state), generation: generation)
                guard try NativeSettingsStorageBridge.mutationReply(result) else { throw APIError.backendUnavailable }
            },
            reloadFrontend: { [weak self] in
                guard let self else { throw APIError.backendUnavailable }
                guard generation == self.nativeSettingsGeneration else { throw CancellationError() }
                if restoreReload {
                    try await self.reloadNativeSettingsFrontend(expectedGeneration: generation, restoreReload: true)
                } else {
                    guard let reload = self.reloadCurrentGraph() else { throw CancellationError() }
                    guard await reload.value else { throw APIError.backendUnavailable }
                }
            },
            readBackupReminder: { [weak self] in
                guard let self else { return false }
                return try await self.nativeLocalValue(.reminder, generation: generation) == "1"
            },
            writeBackupReminder: { [weak self] dismissed in
                guard let self else { throw APIError.backendUnavailable }
                try await self.writeNativeLocalValue(
                    dismissed ? "1" : nil, key: .reminder, generation: generation)
            })
    }

    /// Receipt seeds update shared read lanes without triggering another provider request.
    private func bindNativeSettingsAI(_ settings: NativeSettingsAIModel, chat: AIChatScreens) {
        settings.didReceiveStatus = { [weak chat] receipt in
            chat?.chat.seedSharedStatus(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        settings.didReceiveModels = { [weak chat] receipt in
            chat?.chat.seedSharedModels(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        settings.didReceiveResearch = { [weak chat] receipt in
            chat?.investigation.seedSharedResearch(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        chat.chat.didReceiveStatus = { [weak settings] receipt in
            settings?.seedSharedStatus(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        chat.chat.didReceiveModels = { [weak settings] receipt in
            settings?.seedSharedModels(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        chat.investigation.didReceiveResearch = { [weak settings] receipt in
            settings?.seedSharedResearch(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        settings.didInvalidateSharedReads = { [weak chat] keys in
            chat?.chat.invalidateSharedAIReads(keys)
            if keys.contains("openai-research-status") { chat?.investigation.invalidateSharedResearch() }
        }
        chat.chat.didInvalidateSharedReads = { [weak settings] keys in settings?.invalidateSharedAIReads(keys) }
    }

    /// Fixed scripts and typed argument binding: no source text is constructed from local values.
    private func nativeSettingsScript(
        _ script: String, arguments: [String: JSONValue] = [:], didCompleteActual: (@Sendable () -> Void)? = nil
    ) async throws -> JSONValue {
        guard queue.isReady, let webView = webShell?.webView else {
            didCompleteActual?()
            throw APIError.backendUnavailable
        }
        let bound: [String: Any]
        do {
            bound =
                try JSONSerialization.jsonObject(with: JSONValue.object(arguments).serialized()) as? [String: Any]
                ?? [:]
        } catch {
            didCompleteActual?()
            throw error
        }
        return try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<JSONValue, any Error>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<JSONValue, any Error>?>(initialState: continuation)
            let resume: @Sendable (Result<JSONValue, any Error>) -> Void = { result in
                let waiting = pending.withLock { state -> CheckedContinuation<JSONValue, any Error>? in
                    defer { state = nil }
                    return state
                }
                waiting?.resume(with: result)
            }
            let timeout = Task {
                do { try await Task.sleep(for: Self.adminTokenTimeout) } catch { return }
                resume(.failure(APIError.backendUnavailable))
            }
            webView.callAsyncJavaScript(
                "return JSON.stringify(await (async () => {\n" + script + "\n})());",
                arguments: bound, in: nil, in: .page
            ) { result in
                // A caller timeout is not proof that WebKit stopped the mutation.
                // Storage restore fences release only on this physical completion.
                didCompleteActual?()
                do {
                    guard let text = try result.get() as? String else { throw APIError.backendUnavailable }
                    resume(.success(try JSONValue.parse(Data(text.utf8))))
                } catch { resume(.failure(error)) }
                timeout.cancel()
            }
        }
    }

    private func publishNativeSettings(kind: String, key: String, value: TaxValue) {
        guard ["app_settings", "dashboard_settings", "theme_settings"].contains(key) else { return }
        if kind == "draft" { nativeSettingsDrafts[key] = value }
        let generation = nativeSettingsGeneration
        Task { [weak self] in
            guard let self, generation == self.nativeSettingsGeneration, self.queue.isReady,
                let bytes = try? JSONEncoder().encode(value)
            else { return }
            _ = try? await self.nativeFrontendMutationScript(
                """
                const value = JSON.parse(valueJSON);
                const detail = {kind, key, value};
                if (kind === 'draft') {
                    window.__VISION_NATIVE_SETTINGS_SNAPSHOT__[key] = value;
                } else {
                    detail.expected = {exists: true, value};
                }
                window.dispatchEvent(new CustomEvent('vision:native-settings', {detail}));
                return true;
                """,
                arguments: [
                    "kind": .string(kind), "key": .string(key),
                    "valueJSON": .string(String(decoding: bytes, as: UTF8.self)),
                ], generation: generation)
        }
    }

    private func observeNativeSettingsSession(model: NativeShellModel, generation: UUID) {
        withObservationTracking {
            _ = model.nativeSettings?.sessionTierOverride
            _ = model.nativeSettings?.isLoaded
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model, generation == self.nativeSettingsGeneration else { return }
                self.resolveNativeSettingsAppearance()
                self.publishNativeSettingsSession()
                self.observeNativeSettingsSession(model: model, generation: generation)
            }
        }
    }

    private func publishNativeSettingsSession() {
        let generation = nativeSettingsGeneration
        let tier = shellModel.nativeSettings?.sessionTierOverride
        Task { [weak self] in
            guard let self, generation == self.nativeSettingsGeneration, self.queue.isReady else { return }
            _ = try? await self.nativeFrontendMutationScript(
                """
                window.__VISION_NATIVE_SETTINGS_SESSION_TIER__.value = tier;
                window.dispatchEvent(new CustomEvent('vision:native-settings-session', {detail:{sessionTierOverride:tier}}));
                return true;
                """, arguments: ["tier": tier.map(JSONValue.string) ?? .null], generation: generation)
        }
    }

    private func loadNativeSettingsLegacyTheme(document: NativeRendererReadiness.Document) async {
        guard let model = shellModel.nativeSettings else { return }
        let generation = nativeSettingsGeneration
        guard let reply = try? await nativeSettingsScript(NativeSettingsStorageBridge.legacyThemeScript),
            let text = reply.stringValue, let raw = try? JSONDecoder().decode(TaxValue.self, from: Data(text.utf8)),
            generation == nativeSettingsGeneration, rendererReadiness.isCurrentReady(document),
            !restoreFenceEntered, pendingRestoreReload == nil, restoredNativeGeneration == nil
        else { return }
        var legacy: [String: TaxValue] = [:]
        if let mode = raw["mode"]?.stringValue, ["light", "dark"].contains(mode) { legacy["mode"] = .string(mode) }
        if let variant = raw["variant"]?.stringValue, ThemeVariant(rawValue: variant) != nil {
            legacy["variant"] = .string(variant)
        }
        model.legacyTheme = legacy.isEmpty ? nil : .object(legacy)
        if model.isLoaded { await model.load(force: true) }
    }

    private func resolveNativeSettingsAppearance() {
        guard let settings = shellModel.nativeSettings, settings.isLoaded else { return }
        let screen = window?.screen ?? NSScreen.main
        let scale = screen?.backingScaleFactor ?? 1
        let pixels = Double((screen?.frame.width ?? 0) * (screen?.frame.height ?? 0) * scale * scale)
        let systemDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let resolved = NativeSettingsAppearanceResolver.resolve(
            theme: settings.themeRaw, settings: shellModel.settings, systemIsDark: systemDark,
            physicalPixelCount: pixels, sessionTierOverride: settings.sessionTierOverride,
            previousAppearance: shellModel.theme.appearance)
        if settings.isLargeDisplay != resolved.isLargeDisplay { settings.isLargeDisplay = resolved.isLargeDisplay }
        var selection = resolved.theme
        if resolved.systemAccent, let hex = accentColor(), let tokens = AccentColor.themeTokens(hex: hex) {
            selection.systemAccentColor = tokens.color
            selection.systemAccentForegroundColor = tokens.foreground
        }
        let changed = selection != shellModel.theme
        shellModel.theme = selection
        if documentSelection != .retainedWeb {
            // ElectronBridge's effect in renderer mode: vibrancy only on the effective 'enhanced' tier.
            _ = setVibrancy(resolved.effectiveVisualEffects == "enhanced")
        }
        lastSettingsClockRefresh = Date()
        lastSettingsDisplayPixels = pixels
        lastSettingsSystemIsDark = systemDark
        if changed {
            let palette = selection.palette
            func components(_ color: HSLColor) -> String { "\(color.hue) \(color.saturation)% \(color.lightness)%" }
            if let splash = SplashTheme.parse(
                .object([
                    "mode": .string(selection.appearance.rawValue),
                    "background": .string(components(palette.primary)),
                    "foreground": .string(components(palette.primaryForeground)),
                    "surface": .string(components(palette.background)), "text": .string(components(palette.foreground)),
                ]))
            {
                self.palette = LaunchAppearance.palette(theme: splash)
                applyPalette()
                let supervisor = supervisor
                Task {
                    _ = try? await supervisor.updateSettings { $0[LaunchAppearance.splashThemeKey] = splash.jsonValue }
                }
            }
        }
    }

    private func startNativeSettingsAppearanceWatch() {
        settingsAppearanceTask?.cancel()
        settingsAppearanceTask = Task { [weak self] in
            while !Task.isCancelled {
                do { try await Task.sleep(for: .seconds(5)) } catch { return }
                guard let self else { return }
                let screen = self.window?.screen ?? NSScreen.main
                let scale = screen?.backingScaleFactor ?? 1
                let pixels = Double((screen?.frame.width ?? 0) * (screen?.frame.height ?? 0) * scale * scale)
                let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                let clockDue =
                    self.shellModel.nativeSettings?.themeString("mode", fallback: "dark") == "schedule"
                    && Date().timeIntervalSince(self.lastSettingsClockRefresh) >= 60
                if pixels != self.lastSettingsDisplayPixels || dark != self.lastSettingsSystemIsDark || clockDue {
                    self.resolveNativeSettingsAppearance()
                }
            }
        }
    }

    private func reloadNativeSettingsFrontend(
        expectedGeneration: UUID, restoreReload: Bool = false, manualReloadOwned: Bool = false
    ) async throws {
        guard expectedGeneration == nativeSettingsGeneration else { return }
        if manualReloadTask != nil, !manualReloadOwned { return }
        if let pendingRestoreReload {
            guard restoreReload, pendingRestoreReload == expectedGeneration else { return }
        }
        if let running = nativeSettingsRebuildTask {
            try await running.value
            return
        }
        guard let webShell else { throw APIError.backendUnavailable }
        if let session = restoredCompletionDataSession {
            await session.suspendAndDrain()
            await session.retireForReload()
        }
        if let session = restoredFrontendSession {
            // Logical timeouts do not prove that WebKit stopped the accepted restore writes.
            await session.suspendAndDrain()
            await session.retireForReload()
        }
        rendererDocumentChanged()
        try await rebuildNativeSettingsGraph(expectedGeneration: expectedGeneration)
        if pendingRestoreReload == expectedGeneration { pendingRestoreReload = nil }
        // A readiness receipt from the outgoing document may have arrived while
        // the graph drained. The incoming document must establish its own authority.
        rendererDocumentChanged()
        webShell.reload()
    }

    private func rebuildNativeSettingsGraph(expectedGeneration: UUID) async throws {
        if let running = nativeSettingsRebuildTask {
            try await running.value
            return
        }
        guard expectedGeneration == nativeSettingsGeneration else { return }
        let task = Task { [weak self] in
            guard let self else { throw APIError.backendUnavailable }
            try await self.performNativeSettingsGraphRebuild(expectedGeneration: expectedGeneration)
        }
        nativeSettingsRebuildTask = task
        defer { nativeSettingsRebuildTask = nil }
        try await task.value
    }

    private func performNativeSettingsGraphRebuild(expectedGeneration: UUID) async throws {
        guard expectedGeneration == nativeSettingsGeneration else { return }
        guard let webView = webShell?.webView else { throw APIError.backendUnavailable }
        let old = shellModel
        holdNativeGraphInput(old)
        await localStateSession.suspendAndDrain()
        await localStateSession.retireForReload()
        await drainNativeLocalWrites(old)
        old.commandPalette?.retireForReload()
        old.shellNotifications?.didDisappear()
        old.onboarding?.didDisappear()
        old.reports?.retireForReload()
        old.nativeSettings?.retireForReload()
        await settingsWriter.retireForReload()
        if let streams = old.aiChat?.chat.streams {
            for id in streams.activeIDs { streams.stop(id: id) }
        }
        await dataSession.retireForReload()
        old.analysis?.didDisappear()
        old.research?.didDisappear(route: old.route)
        old.researchForecast?.didDisappear()
        old.researchChartBuilder?.didDisappear()
        old.researchDossiers?.didDisappear()
        old.aiChat?.didDisappear()
        old.settingsAI?.didDisappear()
        old.settingsBackup?.didDisappear()
        await apiClient.invalidateSharedAIReads(keys: [
            "ollama-status", "ollama-models", "openai-research-status", "provider-keys", "agentcloak-desktop",
        ])
        nativeSettingsDrafts = [:]
        onboardingRestoreIntent = nil
        restoredFrontendSession = nil
        restoredCompletionDataSession = nil
        dataSession = NativeDataSession()
        localStateSession = NativeLocalStateSession()
        apiClient = makeAPIClient()
        settingsWriter = SettingsWriter(transport: settingsTransport)
        // Capture after all teardown awaits. The initializer seeds location without
        // replaying navigation or starting route loads before document readiness.
        let model = makeShellModel(initialRoute: old.route)
        holdNativeGraphInput(model)
        shellModel = model
        publishNativeOnboardingState(complete: .null, presented: false, generation: nativeSettingsGeneration)
        let hidden = shellHost?.isHidden ?? false
        shellHost?.removeFromSuperview()
        let host = NSHostingView(
            rootView: ShellRootView(model: model) { hidden in
                WebViewHost(webView: webView, hidden: hidden || model.isReloadingGraph)
            })
        host.sizingOptions = []
        host.sceneBridgingOptions = []
        host.frame = container?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        host.isHidden = hidden
        container?.addSubview(host, positioned: .below, relativeTo: launchView)
        shellHost = host
        if restoredNativeGeneration == expectedGeneration { restoredNativeGeneration = nil }
    }

    /// The sections the user hid (`SIDEBAR_HIDDEN_SECTIONS` of the web sidebar), per Mac.
    private static let hiddenSectionsKey = "nativeSidebarHiddenSections"

    private static func loadHiddenSections() -> [NavSectionID: Bool]? {
        guard let stored = UserDefaults.standard.dictionary(forKey: hiddenSectionsKey) as? [String: Bool] else {
            return nil
        }
        var hidden: [NavSectionID: Bool] = [:]
        for (key, value) in stored {
            if let id = NavSectionID(rawValue: key) { hidden[id] = value }
        }
        return hidden
    }

    private static func saveHiddenSections(_ hidden: [NavSectionID: Bool]) {
        UserDefaults.standard.set(
            Dictionary(uniqueKeysWithValues: hidden.map { ($0.key.rawValue, $0.value) }), forKey: hiddenSectionsKey)
    }

    /// The admin Bearer token of the page's session. The web app keeps it only in
    /// `sessionStorage` (`vision.adminToken`, never in settings.json), so native requests
    /// read it from the page; without one the backend's loopback allowlist applies.
    /// A page that never answers (hung or reloading) gives no token after `adminTokenTimeout`.
    private func adminToken() async -> String? {
        guard queue.isReady, let webView = webShell?.webView else { return nil }
        return await withCheckedContinuation { (continuation: CheckedContinuation<String?, Never>) in
            // Whichever comes first, the page's answer or the timeout, resumes exactly once.
            let pending = OSAllocatedUnfairLock<CheckedContinuation<String?, Never>?>(initialState: continuation)
            let resume: @Sendable (String?) -> Void = { token in
                let waiting = pending.withLock { state -> CheckedContinuation<String?, Never>? in
                    defer { state = nil }
                    return state
                }
                waiting?.resume(returning: token)
            }
            let delay = Self.adminTokenTimeout
            let timeout = Task {
                try? await Task.sleep(for: delay)
                resume(nil)
            }
            // Always a string: a `null` result is where WebKit's Swift bridging is fragile.
            webView.callAsyncJavaScript(
                Self.adminTokenScript, arguments: [:], in: nil, in: .page
            ) { result in
                let token = (try? result.get()) as? String
                resume(token.flatMap { $0.isEmpty ? nil : $0 })
                timeout.cancel()
            }
        }
    }

    private static let adminTokenTimeout: Duration = .seconds(5)

    /// Home and Tax share the web app's per-device dismissals. Only these known keys are
    /// accessible, and every argument goes through WebKit's argument binding.
    private func homeLocalStorage(key: String, value: JSONValue? = nil, generation: UUID? = nil) async -> JSONValue? {
        if let generation, (try? requireNativeGeneration(generation)) == nil { return nil }
        let result = await webStorage(key: key, value: value, session: false, generation: generation)
        if let generation, (try? requireNativeGeneration(generation)) == nil { return nil }
        return result
    }

    private func readChartLayouts(generation: UUID) async throws -> Data? {
        try await chartLayoutStorage(writing: nil, generation: generation).map { Data($0.utf8) }
    }

    private func writeChartLayouts(_ data: Data, generation: UUID) async -> Bool {
        do {
            let value = try ResearchChartStorageBridge.writeValue(data)
            return try await chartLayoutStorage(writing: value, generation: generation) == value
        } catch { return false }
    }

    private func chartLayoutStorage(writing value: String?, generation: UUID) async throws -> String? {
        try requireNativeGeneration(generation)
        let readSession = localStateSession
        if value == nil { try await readSession.checkRead() }
        guard queue.isReady, let webView = webShell?.webView else { throw APIError.backendUnavailable }
        let admission = value == nil ? nil : try await beginNativeStorageWrite()
        do { try requireNativeGeneration(generation) } catch {
            if let (session, token) = admission { await session.finishWrite(token) }
            throw error
        }
        let result = try await withCheckedThrowingContinuation {
            (continuation: CheckedContinuation<String?, any Error>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<String?, any Error>?>(initialState: continuation)
            let resume: @Sendable (Result<String?, any Error>) -> Void = { result in
                let waiting = pending.withLock { state -> CheckedContinuation<String?, any Error>? in
                    defer { state = nil }
                    return state
                }
                waiting?.resume(with: result)
            }
            let timeout = Task {
                try? await Task.sleep(for: Self.adminTokenTimeout)
                resume(.failure(APIError.backendUnavailable))
            }
            webView.callAsyncJavaScript(
                ResearchChartStorageBridge.script,
                arguments: [
                    "key": ResearchChartStorageBridge.key, "value": value ?? "", "writing": value != nil,
                ], in: nil, in: .page
            ) { result in
                if let (session, token) = admission { Task { await session.finishWrite(token) } }
                do {
                    guard let text = try result.get() as? String else { throw APIError.backendUnavailable }
                    resume(.success(try ResearchChartStorageBridge.readReply(text)))
                } catch { resume(.failure(error)) }
                timeout.cancel()
            }
        }
        try requireNativeGeneration(generation)
        if value == nil { try await readSession.checkRead() }
        return result
    }

    /// Import checkpoints share the retained web page's session and contain metadata only.
    private func portfolioSessionStorage(key: String, value: JSONValue? = nil, generation: UUID) async -> JSONValue? {
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        let result = await webStorage(key: key, value: value, session: true, generation: generation)
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        return result
    }

    private func webStorage(key: String, value: JSONValue?, session: Bool, generation: UUID? = nil) async -> JSONValue?
    {
        let permitted =
            session
            ? ["vision.portfolio-import.latest-session.v1", "vision.portfolio-import.latest-review-settings.v1"]
            : [
                "vision.home.dismissedAccountInactivity", "dismissed_upcoming_planned_payments",
                TaxDeductionsModel.dismissalStorageKey, "vision.analysis.sqlHistory",
            ]
        guard permitted.contains(key),
            queue.isReady, let webView = webShell?.webView
        else { return nil }
        let admission = value == nil ? nil : try? await beginNativeStorageWrite()
        guard value == nil || admission != nil else { return nil }
        if let generation, (try? requireNativeGeneration(generation)) == nil {
            if let (session, token) = admission { await session.finishWrite(token) }
            return nil
        }
        let encoded = value.flatMap { try? String(data: $0.serialized(), encoding: .utf8) }
        return await withCheckedContinuation { (continuation: CheckedContinuation<JSONValue?, Never>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<JSONValue?, Never>?>(initialState: continuation)
            let resume: @Sendable (JSONValue?) -> Void = { answer in
                let waiting = pending.withLock { state -> CheckedContinuation<JSONValue?, Never>? in
                    defer { state = nil }
                    return state
                }
                waiting?.resume(returning: answer)
            }
            let timeout = Task {
                try? await Task.sleep(for: Self.adminTokenTimeout)
                resume(nil)
            }
            webView.callAsyncJavaScript(
                "try { const storage = session ? sessionStorage : localStorage; if (writing) { if (removing) storage.removeItem(key); else storage.setItem(key, value); } return storage.getItem(key) || 'null'; } catch { return 'null'; }",
                arguments: [
                    "key": key, "value": encoded ?? "null", "writing": value != nil,
                    "session": session, "removing": session && value == .null,
                ], in: nil, in: .page
            ) { result in
                if let (session, token) = admission { Task { await session.finishWrite(token) } }
                let answer = ((try? result.get()) as? String).flatMap { try? JSONValue.parse(Data($0.utf8)) }
                resume(answer)
                timeout.cancel()
            }
        }
    }

    private static let adminTokenScript = AdminTokenScript.read

    /// The admin token card's access to the page's `sessionStorage`.
    private func makeAdminTokenAccess(generation: UUID) -> AdminTokenAccess {
        AdminTokenAccess(
            read: { [weak self] in await self?.adminToken(generation: generation) },
            write: { [weak self] token in await self?.writeAdminToken(token, generation: generation) ?? false })
    }

    private func adminToken(generation: UUID) async -> String? {
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        let token = await adminToken()
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        return token
    }

    /// `setAdminToken(token)` in the page: the trimmed token, or removal for a blank one. The
    /// token goes in as a script argument, never as script text. `false` when the page is not
    /// ready, the script fails or the page does not answer within `adminTokenTimeout`; the
    /// storage is then unchanged as far as the card knows.
    private func writeAdminToken(_ token: String, generation: UUID) async -> Bool {
        guard (try? requireNativeGeneration(generation)) != nil else { return false }
        guard queue.isReady, let webView = webShell?.webView else { return false }
        guard let (session, writeToken) = try? await beginNativeStorageWrite() else { return false }
        guard (try? requireNativeGeneration(generation)) != nil else {
            await session.finishWrite(writeToken)
            return false
        }
        let stored = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<Bool, Never>?>(initialState: continuation)
            let resume: @Sendable (Bool) -> Void = { stored in
                let waiting = pending.withLock { state -> CheckedContinuation<Bool, Never>? in
                    defer { state = nil }
                    return state
                }
                waiting?.resume(returning: stored)
            }
            let delay = Self.adminTokenTimeout
            let timeout = Task {
                try? await Task.sleep(for: delay)
                resume(false)
            }
            // The script answers "ok", or an empty string when `sessionStorage` is unavailable.
            webView.callAsyncJavaScript(
                AdminTokenScript.write, arguments: [AdminTokenScript.argument: token], in: nil, in: .page
            ) { result in
                Task { await session.finishWrite(writeToken) }
                resume(((try? result.get()) as? String) == "ok")
                timeout.cancel()
            }
        }
        guard (try? requireNativeGeneration(generation)) != nil else { return false }
        return stored
    }

    private static var localeDirectory: String? {
        Bundle.main.resourceURL?.appendingPathComponent("i18n", isDirectory: true).path
    }

    override init() {
        let settings = ShellController.readSettingsFile(AppRuntime.supervisor.settingsPath)
        let language = ShellStrings.resolveLanguage(
            requested: settings["nativeLanguage"], preferredLanguages: Locale.preferredLanguages)
        let strings = ShellStrings.load(language: language, directory: ShellController.localeDirectory)
        let palette = LaunchAppearance.palette(theme: LaunchAppearance.theme(fromSettings: settings))
        let transport = URLSessionSettingsTransport()
        initialSettings = settings
        self.strings = strings
        self.palette = palette
        launchModel = LaunchModel(appName: ShellController.appName, strings: strings, palette: palette)
        settingsTransport = transport
        settingsWriter = SettingsWriter(transport: transport)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        backupService = BackupService(
            context: BackupContext(
                environment: ProcessInfo.processInfo.environment,
                appVersion: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
                    ?? "unknown",
                userDataDirectory: AppRuntime.variant.userDataDirectory(homeDirectory: home),
                homeDirectory: home,
                appName: ShellController.appName),
            settings: AppRuntime.supervisor,
            runtimeProvider: { await AppRuntime.supervisor.backupRuntime() },
            passphraseStoreFactory: { [service = AppRuntime.variant.backupPassphraseService] account in
                KeychainPassphraseStore(account: account, service: service)
            },
            logger: OSLogRuntimeLog(logger: AppRuntime.shellLogger),
            auditProvider: { await AppRuntime.supervisor.auditRuntime() })
        super.init()
        launchModel.onRetry = { [weak self] in self?.launch() }
        launchModel.onOpenLogs = { [weak self] in _ = try? self?.openLogs() }
    }

    /// `readSavedWindowBounds`: a synchronous read before the window exists.
    private static func readSettingsFile(_ path: String) -> [String: JSONValue] {
        guard let data = FileManager.default.contents(atPath: path),
            let fields = (try? JSONValue.parse(data))?.objectValue
        else {
            return [:]
        }
        return fields
    }

    // MARK: - Launch

    func start() {
        NSWindow.allowsAutomaticWindowTabbing = false
        createWindow()
        installMenus()
        observeAccentColor()
        launch()
    }

    /// Shows the launch state and resolves the runtime; Retry and `recovery:retry` call it again.
    func launch() {
        launchTask?.cancel()
        pageLoadTask?.cancel()
        revealTask?.cancel()
        launchModel.state = .checking
        launchModel.statusKey = LaunchAppearance.statusKey(for: .idle)
        showLaunchView()
        launchTask = Task { [weak self] in
            let statusTask = Task {
                while !Task.isCancelled {
                    let phase = await AppRuntime.supervisor.phase
                    self?.launchModel.statusKey = LaunchAppearance.statusKey(for: phase)
                    try? await Task.sleep(for: .milliseconds(200))
                }
            }
            let state = await ShellResolver.resolve()
            statusTask.cancel()
            guard !Task.isCancelled else { return }
            self?.apply(state)
        }
    }

    private func apply(_ state: ShellState) {
        launchModel.state = state
        switch state {
        case .checking, .unavailable:
            stopHealthWatchdog()
            showLaunchView()
        case .ready(let url, let backendSource):
            appURL = url
            if webShell == nil {
                let selection = NativeHelperDocumentSelection.select(
                    environment: ProcessInfo.processInfo.environment, isDebugBuild: AppRuntime.isDebugBuild,
                    rawVariant: AppRuntime.variant.rawValue, backendSource: backendSource, backendURL: url,
                    websiteDataStoreIdentifier: "default")
                // A cold menu or Finder action may already have built a renderer-mode graph;
                // presentation never changes under an existing graph.
                if selection != .retainedWeb, hasMadeShellModel {
                    logger.warning("[shell] helper document ineligible: the shell graph already exists")
                } else {
                    documentSelection = selection
                }
                if documentSelection != .retainedWeb {
                    logger.log("[shell] Debug Demo helper document selected (ADR-207)")
                }
            }
            let documentURL: URL
            if case .helperDocument(let source) = documentSelection {
                // The helper is bound to its supervised origin; a changed origin fails closed.
                guard WebShell.origin(of: url) == source.backendOrigin else {
                    apply(.unavailable(strings.t("app.errorPageMessage")))
                    return
                }
                documentURL = source.helperURL
            } else {
                documentURL = url
            }
            let shell = webShell ?? makeWebShell()
            shellHost?.isHidden = true
            rendererDocumentChanged()
            // `loadApplicationPage`: the audit session is established before the page
            // loads; the closure timer then runs while the page is up.
            pageLoadTask?.cancel()
            pageLoadTask = Task { [weak self] in
                await self?.auditChannels.applicationWillLoad()
                guard !Task.isCancelled, let self, self.appURL == url else { return }
                shell.load(documentURL)
                self.startHealthWatchdog(url)
            }
        }
    }

    private func showLaunchView() {
        revealTask?.cancel()
        shellHost?.isHidden = true
        launchView?.isHidden = false
    }

    private func revealWebView() {
        revealTask?.cancel()
        guard let host = shellHost, host.isHidden, let webView = webShell?.webView, case .ready = launchModel.state
        else { return }
        host.isHidden = false
        launchView?.isHidden = true
        if shellModel.detail == .web { window?.makeFirstResponder(webView) }
    }

    /// Stops the debounced frame save and writes the current frame, then runs the
    /// quit-time backup when it is enabled; the shutdown task awaits both before the
    /// runtime stops, within the 45-second quit timeout.
    func prepareForQuit() async {
        stopHealthWatchdog()
        frameSaveTask?.cancel()
        await saveFrame()
        await runQuitBackup()
        // After the quit backup, before the services stop (Electron's `will-quit`).
        await auditChannels.endSession()
    }

    /// Quit while a native screen holds unsaved changes shows the Leave this page? alert
    /// (`unsavedChanges.*`); `true` (Leave and discard) lets the app quit, Stay on page
    /// (the default button) cancels it.
    func confirmQuitWithUnsavedChanges() -> Bool {
        guard shellHost != nil, shellModel.hasGuardedUnsavedChanges else { return true }
        let strings = shellModel.strings
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = strings.t("unsavedChanges.title")
        alert.informativeText = strings.t("unsavedChanges.description")
        let stay = alert.addButton(withTitle: strings.t("unsavedChanges.stay"))
        let leave = alert.addButton(withTitle: strings.t("unsavedChanges.leave"))
        stay.keyEquivalent = "\r"
        leave.keyEquivalent = ""
        leave.hasDestructiveAction = true
        showWindow()
        return alert.runModal() == .alertSecondButtonReturn
    }

    /// The `will-quit` backup: the database setting (else the `settings.json` mirror),
    /// resolved with the iCloud Drive default. Skipped when the runtime never became ready.
    private func runQuitBackup() async {
        guard await supervisor.backupRuntime() != nil else { return }
        let supervisor = self.supervisor
        let raw = await BackupSettings.rawForQuit(
            baseURL: appURL, transport: settingsTransport, fallback: { await supervisor.currentSettings() })
        await backupService.runQuitBackup(rawSettings: raw)
    }

    // MARK: - Window

    private func createWindow() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: WindowFrame.defaultSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = Self.appName
        // `titleBarStyle: "hiddenInset"`: the page draws its own topbar under the traffic
        // lights and insets it (`html.electron-mac`, index.css).
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.minSize = WindowFrame.minimumSize
        window.collectionBehavior.insert(.fullScreenPrimary)
        window.tabbingMode = .disallowed
        window.isReleasedWhenClosed = false
        window.backgroundColor = .hsl(palette.base)
        window.delegate = self

        let container = NSView(frame: NSRect(origin: .zero, size: WindowFrame.defaultSize))
        container.autoresizingMask = [.width, .height]
        // Electron's `setVibrancy("under-window")`, shown only while the page asks for it.
        let effectView = NSVisualEffectView(frame: container.bounds)
        effectView.autoresizingMask = [.width, .height]
        effectView.material = .underWindowBackground
        effectView.blendingMode = .behindWindow
        effectView.state = .followsWindowActiveState
        effectView.appearance = Self.vibrancyAppearance(palette)
        effectView.isHidden = true
        container.addSubview(effectView)
        let launchView = NSHostingView(rootView: LaunchStateView(model: launchModel))
        launchView.sizingOptions = []
        launchView.frame = container.bounds
        launchView.autoresizingMask = [.width, .height]
        container.addSubview(launchView)
        window.contentView = container

        let screens = NSScreen.screens.map { (frame: $0.frame, visibleFrame: $0.visibleFrame) }
        let primaryHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
        if let frame = WindowFrame.initialFrame(
            settings: initialSettings, primaryScreenHeight: primaryHeight, screens: screens)
        {
            window.setFrame(frame, display: false)
        } else {
            window.setFrame(NSRect(origin: .zero, size: WindowFrame.defaultSize), display: false)
            window.center()
        }

        self.window = window
        self.container = container
        self.effectView = effectView
        self.launchView = launchView
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    /// The web view inside the native navigation shell; the launch view covers both until
    /// the page is ready.
    private func makeWebShell() -> WebShell {
        var helperSource: NativeHelperDocumentSession.Source?
        if case .helperDocument(let source) = documentSelection { helperSource = source }
        let shell = WebShell(controller: self, helperSource: helperSource)
        let webView = shell.webView
        webView.pageZoom = PageZoom.persisted(initialSettings[PageZoom.settingsKey])
        webView.underPageBackgroundColor = .hsl(palette.base)
        let model = shellModel
        let host = NSHostingView(
            rootView: ShellRootView(model: model) { hidden in
                WebViewHost(webView: webView, hidden: hidden || model.isReloadingGraph)
            })
        host.sizingOptions = []
        // The window keeps its own title and has no toolbar; SwiftUI must not add either.
        host.sceneBridgingOptions = []
        host.frame = container?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        host.isHidden = true
        container?.addSubview(host, positioned: .below, relativeTo: launchView)
        shellHost = host
        webShell = shell
        model.setPageZoom(Double(webView.pageZoom))
        return shell
    }

    func showWindow() {
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // macOS convention kept from Electron: closing hides the window, so the booted page
        // keeps its route and a dock click shows it again at once.
        sender.orderOut(nil)
        return false
    }

    func windowDidResize(_ notification: Notification) {
        scheduleFrameSave()
        resolveNativeSettingsAppearance()
    }

    func windowDidMove(_ notification: Notification) {
        scheduleFrameSave()
        resolveNativeSettingsAppearance()
    }

    func windowDidChangeScreen(_ notification: Notification) {
        resolveNativeSettingsAppearance()
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        deliver(.fullScreen, .bool(true))
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        deliver(.fullScreen, .bool(false))
        scheduleFrameSave()
    }

    private func scheduleFrameSave() {
        frameSaveTask?.cancel()
        frameSaveTask = Task { [weak self] in
            try? await Task.sleep(for: WindowFrame.saveDebounce)
            guard !Task.isCancelled else { return }
            await self?.saveFrame()
        }
    }

    private func saveFrame() async {
        // A full-screen window records its restored frame on exit instead.
        guard let window, !window.styleMask.contains(.fullScreen) else { return }
        let primaryHeight = Double(NSScreen.screens.first?.frame.height ?? 0)
        let value = WindowFrame.json(WindowFrame.flipped(window.frame, primaryScreenHeight: primaryHeight))
        do {
            try await supervisor.updateSettings { $0[WindowFrame.settingsKey] = value }
        } catch {
            logger.warning("window-bounds save failed (non-fatal): \(error.localizedDescription, privacy: .public)")
        }
    }

    // MARK: - Web shell callbacks

    private func rendererDocumentChanged(expectingCommit: Bool = true) {
        if expectingCommit {
            rendererReadiness.willNavigate()
        } else {
            rendererReadiness.documentDidCommit()
        }
        queue.documentChanged()
        shellModel.isRendererReady = false
    }

    func documentDidCommit() {
        rendererDocumentChanged(expectingCommit: false)
    }

    func documentDidFinish() {
        revealTask?.cancel()
        revealTask = Task { [weak self] in
            try? await Task.sleep(for: ShellController.revealFallback)
            guard !Task.isCancelled else { return }
            self?.revealWebView()
        }
    }

    func documentDidFail(_ error: Error) {
        logger.error("main-frame load failed: \(error.localizedDescription, privacy: .public)")
        apply(.unavailable("\(strings.t("app.errorPageMessage"))\n\n\(error.localizedDescription)"))
    }

    /// `CrashReloadPolicy` gave up reloading; Try again loads the page afresh.
    func webContentKeepsTerminating() {
        apply(.unavailable(strings.t("app.errorPageMessage")))
    }

    // MARK: - Helper document (ADR-207)

    /// A load or reload of the helper starts a new navigation authority. Graph replacement
    /// retires the old session; a reload within one generation keeps its session.
    func helperDocumentWillNavigate(_ navigationID: UUID) {
        guard case .helperDocument(let source) = documentSelection else { return }
        helperBootstrapTask?.cancel()
        helperBootstrapTask = nil
        helperLanguage = nil
        if helperSession?.generationID != nativeSettingsGeneration {
            helperSession?.retire()
            helperSession = NativeHelperDocumentSession(source: source, generationID: nativeSettingsGeneration)
        }
        do { try helperSession?.beginNavigation(navigationID) } catch {
            failHelperDocument("navigation")
            return
        }
        shellModel.setHelperDocumentState(.loading)
    }

    func helperDocumentDidCommit(_ observation: NativeHelperDocumentSession.Observation?) {
        // A commit of a superseded navigation has no observation and changes nothing.
        guard helperSession != nil, let observation else { return }
        do { try helperSession?.didCommit(observation) } catch { failHelperDocument("commit") }
    }

    /// Only the matching finish issues bootstrap authority; the fixed bootstrap call and the
    /// page's ready callback are then checked independently before startup proceeds.
    func helperDocumentDidFinish(_ observation: NativeHelperDocumentSession.Observation?) {
        guard helperSession != nil, let observation, let webView = webShell?.webView else { return }
        let provenance: NativeHelperDocumentSession.Provenance
        let source: NativeHelperDocumentSession.Source
        do {
            guard let issued = try helperSession?.didFinish(observation), let current = helperSession?.source
            else { return }
            provenance = issued
            source = current
        } catch {
            failHelperDocument("finish")
            return
        }
        let language: NativeHelperDocumentBridge.Language = strings.language == .nl ? .nl : .en
        let command = NativeHelperDocumentBridge.Command.bootstrap(language)
        helperLanguage = language
        let arguments = NativeHelperDocumentBridge.arguments(for: command, provenance: provenance, source: source)
        helperBootstrapTask?.cancel()
        helperBootstrapTask = Task { [weak self] in
            let reply: Any?
            do {
                let bound =
                    try JSONSerialization.jsonObject(with: JSONValue.object(arguments).serialized())
                    as? [String: Any] ?? [:]
                reply = try await webView.callAsyncJavaScript(
                    NativeHelperDocumentBridge.script(for: command), arguments: bound, in: nil, contentWorld: .page)
            } catch {
                guard !Task.isCancelled else { return }
                self?.failHelperDocument("bootstrap")
                return
            }
            guard let self, !Task.isCancelled else { return }
            guard let text = reply as? String,
                let receipt = try? NativeHelperDocumentBridge.decodeReceipt(
                    .string(text), for: command, provenance: provenance),
                let current = self.webShell?.helperObservation(for: nil),
                current.navigationID == observation.navigationID
            else {
                self.failHelperDocument("bootstrap receipt")
                return
            }
            do { try self.helperSession?.acceptBootstrapReceipt(receipt, observation: current) } catch {
                self.failHelperDocument("bootstrap receipt")
                return
            }
            self.helperDocumentAdvanced()
        }
    }

    /// The page's fixed ready/failed callback; `false` rejects the acknowledgement.
    func helperDocumentCallback(
        _ callback: NativeHelperDocumentBridge.Callback, observation: NativeHelperDocumentSession.Observation
    ) -> Bool {
        guard helperSession != nil else { return false }
        do { try helperSession?.acceptCallback(callback, observation: observation) } catch { return false }
        if case .failed = callback {
            failHelperDocument("bootstrap reported")
            return true
        }
        helperDocumentAdvanced()
        return true
    }

    /// Both receipts accepted: the helper stands in for the renderer's `ready()` call.
    private func helperDocumentAdvanced() {
        guard helperSession?.phase == .ready, !rendererReadiness.isReady else { return }
        shellModel.setHelperDocumentState(.ready)
        rendererDidBecomeReady()
        // A language change during bootstrap reached neither command.
        updateHelperDocumentLocale()
    }

    /// The helper's fixed locale command for its unchanged source calculations' formatting.
    private func updateHelperDocumentLocale() {
        let language: NativeHelperDocumentBridge.Language = strings.language == .nl ? .nl : .en
        guard let session = helperSession, session.phase == .ready, let provenance = session.provenance,
            helperLanguage != language, let webView = webShell?.webView
        else { return }
        let command = NativeHelperDocumentBridge.Command.locale(language)
        let arguments = NativeHelperDocumentBridge.arguments(
            for: command, provenance: provenance, source: session.source)
        helperLanguage = language
        Task { [weak self] in
            var accepted = false
            if let bound = try? JSONSerialization.jsonObject(with: JSONValue.object(arguments).serialized())
                as? [String: Any],
                let reply = try? await webView.callAsyncJavaScript(
                    NativeHelperDocumentBridge.script(for: command), arguments: bound, in: nil, contentWorld: .page),
                let text = reply as? String
            {
                accepted =
                    (try? NativeHelperDocumentBridge.decodeReceipt(.string(text), for: command, provenance: provenance))
                    != nil
            }
            guard let self, self.helperSession?.provenance == provenance else { return }
            if !accepted {
                self.helperLanguage = nil
                self.logger.warning("[shell] helper document locale update was not acknowledged")
            }
        }
    }

    private func applyHelperStartup(_ startup: inout NativeNavigationStartup, model: NativeShellModel) {
        guard !startup.hasResolved, let current = model.nativeNavigationLocation?.raw else { return }
        let settings: NativeNavigationStartup.Settings =
            model.settingsLoaded ? .loaded(startupSection: model.settings.startupSection) : .loading
        switch startup.evaluate(currentLocation: current, settings: settings) {
        case .seedNewSession(let target), .replaceCurrentEntry(let target):
            // Selections are raw; the route validator still admits them, as in the source.
            guard target != current, NativeNavigationLocation(target) != nil else { return }
            model.replace(with: target)
        case .waitingForSettings, .unchanged:
            break
        }
    }

    /// StartupRedirect's mirror of the hydrated startup section and the current page.
    private func persistHelperNavigation(model: NativeShellModel, generation: UUID) {
        let route = model.nativeNavigationLocation?.raw
        let section = model.settingsLoaded ? model.settings.startupSection : nil
        Task { [weak self] in
            if let route { try? await self?.writeNativeLocalValue(route, key: .lastRoute, generation: generation) }
            if let section {
                try? await self?.writeNativeLocalValue(section, key: .startupSection, generation: generation)
            }
        }
    }

    private func trackHelperNavigation(model: NativeShellModel, generation: UUID) {
        withObservationTracking {
            _ = model.nativeNavigationLocation?.raw
            _ = model.settings.startupSection
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model, generation == self.nativeSettingsGeneration else { return }
                self.persistHelperNavigation(model: model, generation: generation)
                self.trackHelperNavigation(model: model, generation: generation)
            }
        }
    }

    private func failHelperDocument(_ stage: String) {
        helperSession?.fail()
        logger.error("[shell] helper document \(stage, privacy: .public) failed")
        shellModel.setHelperDocumentState(.failed)
    }

    // MARK: - Renderer messages

    /// `sendToApp`: shows the window and delivers now, or once the page is ready.
    private func sendToApp(_ event: BridgeEvent, _ payload: JSONValue) {
        showWindow()
        for message in queue.send(event, payload) { evaluate(message.event, message.payload) }
    }

    /// `webContents.send` without the queue (full-screen changes).
    private func deliver(_ event: BridgeEvent, _ payload: JSONValue) {
        evaluate(event, payload)
    }

    private func evaluate(_ event: BridgeEvent, _ payload: JSONValue) {
        webShell?.webView.evaluateJavaScript(
            BridgeDispatcher.eventScript(event, payload: payload), completionHandler: nil)
    }

    /// Finder "Open With" and dock drops of a CSV. The native import card always gets the
    /// file (pre-filled, not started); until `app_settings` is read the page also gets it as
    /// `app:csv-opened` and moves to `/import`, so a cold launch does not lose it whichever
    /// side draws the page.
    func openFiles(_ urls: [URL]) {
        for url in urls {
            Task { [weak self] in
                guard let data = await ShellController.readCSV(url), let self else { return }
                let name = url.lastPathComponent
                self.showWindow()
                if self.shellModel.openImportFile(ImportFile(name: name, data: data, mimeType: "text/csv")) { return }
                self.sendToApp(.csvOpened, CSVHandoff.payload(name: name, data: data))
            }
        }
    }

    private nonisolated static func readCSV(_ url: URL) async -> Data? {
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard
            CSVHandoff.accepts(
                path: url.path, isRegularFile: values?.isRegularFile == true, size: values?.fileSize),
            let data = try? Data(contentsOf: url)
        else {
            return nil
        }
        return data
    }

    // MARK: - Menus

    private func installMenus() {
        menuController.shell = self
        NSApp.mainMenu = menuController.makeMenu(
            title: "Main Menu", entries: ApplicationMenu.build(appName: Self.appName, strings: strings))
    }

    func dockMenu() -> NSMenu {
        menuController.makeMenu(title: "", entries: ApplicationMenu.dock(strings: strings))
    }

    private enum PagePrintSnapshot {
        case tax(NativeTaxPrintSnapshot)
        case statistics(NativeStatisticsPrintSnapshot)
        case netWorth(NativeNetWorthPrintSnapshot)
    }

    private func capturePagePrintSnapshot() -> PagePrintSnapshot? {
        guard shellModel.printDisposition == .nativePage else { return nil }
        return switch shellModel.route.path {
        case "/tax": (try? NativeTaxPrintSnapshot.capture(shell: shellModel)).map(PagePrintSnapshot.tax)
        case "/statistics":
            (try? NativeStatisticsPrintSnapshot.capture(shell: shellModel)).map(PagePrintSnapshot.statistics)
        case "/portfolio/net-worth":
            (try? NativeNetWorthPrintSnapshot.capture(shell: shellModel)).map(PagePrintSnapshot.netWorth)
        default: nil
        }
    }

    var canPrintCurrentPage: Bool {
        guard !isPrintingCurrentPage, !restoreFenceEntered, pendingRestoreReload == nil,
            restoredNativeGeneration == nil, shellModel.nativeSettings?.isSuspendedForRestore != true,
            !shellModel.isReloadingGraph, !shellModel.isPresentingNativeOverlay, queue.isReady
        else { return false }
        switch shellModel.printDisposition {
        case .webDocument: return webShell?.webView != nil
        case .nativePage: return capturePagePrintSnapshot() != nil
        case .unavailable: return false
        }
    }

    private func printCurrentPage() {
        guard canPrintCurrentPage else { return }
        if shellModel.printDisposition == .webDocument {
            let operation = webShell?.webView.printOperation(with: NSPrintInfo.shared)
            operation?.showsPrintPanel = true
            operation?.showsProgressPanel = true
            operation?.run()
            return
        }
        guard let snapshot = capturePagePrintSnapshot() else { return }
        let generation = nativeSettingsGeneration
        let route = shellModel.route.string
        isPrintingCurrentPage = true
        Task { [weak self] in
            guard let self else { return }
            defer { self.isPrintingCurrentPage = false }
            do {
                let title: String
                let buildBlocks: @MainActor (CGFloat) -> [NSView]
                switch snapshot {
                case .tax(let snapshot):
                    let presentation = try await NativeTaxPrintPresentation.prepare(snapshot)
                    title = snapshot.strings.t("tax.page.title") + " · " + String(snapshot.year)
                    buildBlocks = { width in
                        NativeTaxPrintDocument.printBlocks(presentation: presentation, width: width)
                    }
                case .statistics(let snapshot):
                    let presentation = NativeStatisticsPrintPresentation.prepare(snapshot)
                    title = snapshot.strings.t("statsPage.title")
                    buildBlocks = { width in
                        NativeStatisticsPrintDocument.printBlocks(presentation: presentation, width: width)
                    }
                case .netWorth(let snapshot):
                    let presentation = NativeNetWorthPrintPresentation.prepare(snapshot)
                    title = snapshot.strings.t("networth.title")
                    buildBlocks = { width in
                        NativeNetWorthPrintDocument.printBlocks(presentation: presentation, width: width)
                    }
                }
                try self.requireNativeGeneration(generation)
                guard self.shellModel.route.string == route, !self.restoreFenceEntered,
                    self.shellModel.printDisposition == .nativePage,
                    self.pendingRestoreReload == nil, !self.shellModel.isPresentingNativeOverlay,
                    !self.shellModel.isReloadingGraph, self.shellModel.nativeSettings?.isSuspendedForRestore != true
                else { return }
                let info = (NSPrintInfo.shared.copy() as? NSPrintInfo) ?? NSPrintInfo.shared
                let pages = NativePagePrintPagesView(printInfo: info, buildBlocks: buildBlocks)
                let operation = NSPrintOperation(view: pages, printInfo: info)
                operation.jobTitle = title
                operation.showsPrintPanel = true
                operation.showsProgressPanel = true
                operation.run()
            } catch is CancellationError {
                return
            } catch {
                guard (try? self.requireNativeGeneration(generation)) != nil else { return }
                self.shellModel.notices.publish(
                    .init(id: 0, kind: .error, key: "common.error", detail: error.localizedDescription), source: UUID())
            }
        }
    }

    /// Keep AppKit input fenced as well as SwiftUI controls. A represented web
    /// view can retain its keyboard responder independently of hit testing.
    private func holdNativeGraphInput(_ model: NativeShellModel) {
        model.isReloadingGraph = true
        guard let webView = webShell?.webView else { return }
        if let window = webView.window, let responder = window.firstResponder as? NSView,
            responder === webView || responder.isDescendant(of: webView)
        {
            window.makeFirstResponder(nil)
        }
        webView.isHidden = true
    }

    @discardableResult
    private func reloadCurrentGraph() -> Task<Bool, Never>? {
        guard appURL != nil, webShell?.webView != nil, manualReloadTask == nil,
            nativeSettingsRebuildTask == nil, !restoreFenceEntered, pendingRestoreReload == nil,
            restoredNativeGeneration == nil, shellModel.nativeSettings?.isSuspendedForRestore != true,
            confirmQuitWithUnsavedChanges()
        else { return nil }
        // The modal leave confirmation can service asynchronous restore requests.
        guard manualReloadTask == nil, nativeSettingsRebuildTask == nil, !restoreFenceEntered,
            pendingRestoreReload == nil, restoredNativeGeneration == nil,
            shellModel.nativeSettings?.isSuspendedForRestore != true
        else { return nil }
        let generation = nativeSettingsGeneration
        let model = shellModel
        holdNativeGraphInput(model)
        manualReloadTask = Task { [weak self] in
            guard let self else { return false }
            defer { self.manualReloadTask = nil }
            await model.onboarding?.flushAcceptedActions()
            await model.analysis?.workspace.flushAcceptedRuns()
            await model.portfolioImports?.session.flushAcceptedCommits()
            await model.nativeSettings?.flush()
            await model.nativeSettings?.suspendForRestore()
            await self.settingsWriter.suspendAndDrain()
            model.closePalette()
            model.closeShortcuts()
            await self.drainNativeLocalWrites(model)
            if let streams = model.aiChat?.chat.streams {
                for id in streams.activeIDs { streams.stop(id: id) }
            }
            model.imports.cancelImport()
            model.portfolioImports?.advanced.cancel()
            await self.dataSession.suspendAndDrain()
            await self.drainNativeLocalWrites(model)
            do {
                try await self.reloadNativeSettingsFrontend(expectedGeneration: generation, manualReloadOwned: true)
                return true
            } catch {
                guard generation == self.nativeSettingsGeneration else { return false }
                await self.localStateSession.resumeAfterFailedRestore()
                model.nativeSettings?.resumeAfterFailedRestore()
                await self.settingsWriter.resumeAfterFailedRestore()
                await self.dataSession.resumeAfterFailedRestore()
                model.isReloadingGraph = false
                model.isRendererReady = self.queue.isReady
                self.logger.error("native reload failed: \(error.localizedDescription, privacy: .public)")
                return false
            }
        }
        return manualReloadTask
    }

    func run(_ command: MenuCommand) {
        guard !shellModel.isReloadingGraph else { return }
        if case .renderer(let action) = command, documentSelection != .retainedWeb {
            // The helper document has no renderer: native owners take every menu action.
            if !shellModel.acceptNativeMenuAction(action) {
                logger.warning("[shell] menu action \(action.action, privacy: .public) has no native owner")
            }
            return
        }
        switch command {
        case .print:
            printCurrentPage()
        case .renderer(let action) where action == .toggleSidebar:
            // The sidebar is native from phase 2.
            shellModel.toggleSidebar()
        case .renderer(let action) where action == .newTransaction:
            // The native Add transaction sheet while `/transactions` is native; else the page's.
            if !shellModel.newTransaction() {
                shellModel.willPresent(action)
                sendToApp(.menuAction, BridgeDispatcher.menuActionPayload(action))
            }
        case .renderer(let action) where action.action == "navigate":
            // Through the shell, so a native screen's unsaved-changes guard can hold it.
            if let path = action.payload { shellModel.navigate(to: path) }
        case .renderer(let action):
            shellModel.willPresent(action)
            sendToApp(.menuAction, BridgeDispatcher.menuActionPayload(action))
        case .openExternal(let link):
            if let url = ShellLinks.trustedExternalURL(URL(string: link)) { NSWorkspace.shared.open(url) }
        case .about:
            showAboutPanel()
        case .reload:
            if appURL != nil { reloadCurrentGraph() } else { launch() }
        case .resetZoom:
            applyPageZoom(1)
        case .zoomIn:
            applyPageZoom(
                PageZoom.zoomedIn(from: webShell.map { Double($0.webView.pageZoom) } ?? shellModel.pageZoom))
        case .zoomOut:
            applyPageZoom(
                PageZoom.zoomedOut(from: webShell.map { Double($0.webView.pageZoom) } ?? shellModel.pageZoom))
        default:
            // Role items use AppKit's standard actions (MenuController).
            break
        }
    }

    /// `startHealthWatchdog`: a lost backend ends the audit session and is announced once;
    /// recovery re-verifies the audit history and restarts the closure timer. The renderer
    /// still receives `backend:lost` / `backend:restored`.
    private func startHealthWatchdog(_ url: URL) {
        stopHealthWatchdog()
        healthWatchdogTask = Task { [weak self] in
            var watchdog = BackendHealthWatchdog()
            while !Task.isCancelled {
                try? await Task.sleep(for: BackendHealthWatchdog.interval)
                guard !Task.isCancelled else { return }
                let status = try? await BackendHealth.status(
                    baseURL: url, timeout: BackendHealthWatchdog.probeTimeout)
                guard !Task.isCancelled, let self, self.appURL == url else { return }
                switch watchdog.record(healthy: BackendHealthWatchdog.isHealthy(status: status)) {
                case .lost:
                    await self.auditChannels.endSession()
                    let message = self.shellModel.strings.t("app.backendLost")
                    self.sendToApp(.backendLost, .object(["message": .string(message)]))
                    self.backendNoticeID = self.shellModel.notices.publish(
                        .init(id: 0, kind: .warning, key: "app.backendLost"), source: self.backendNoticeSource,
                        lifetime: 30, replacementKey: "backend-health")
                case .restored:
                    await self.auditChannels.checkIntegrity()
                    await self.auditChannels.startClosureTimer()
                    self.sendToApp(.backendRestored, .null)
                    if let id = self.backendNoticeID { self.shellModel.notices.dismiss(id) }
                    self.backendNoticeID = nil
                case nil:
                    break
                }
            }
        }
    }

    private func stopHealthWatchdog() {
        healthWatchdogTask?.cancel()
        healthWatchdogTask = nil
    }

    /// Applies a zoom step to the page and native screens and keeps it for the next launch.
    private func applyPageZoom(_ zoom: Double) {
        webShell?.webView.pageZoom = zoom
        shellModel.setPageZoom(zoom)
        let supervisor = supervisor
        Task {
            do { try await supervisor.updateSettings { $0[PageZoom.settingsKey] = .double(zoom) } } catch {
                AppRuntime.shellLogger.warning("page zoom save failed (non-fatal)")
            }
        }
    }

    private func showAboutPanel() {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? ""
        let year = Calendar.current.component(.year, from: Date())
        NSApp.orderFrontStandardAboutPanel(options: [
            .applicationName: Self.appName,
            .applicationVersion: version,
            NSApplication.AboutPanelOptionKey(rawValue: "Copyright"): "© \(year) Vision · AGPL-3.0",
        ])
        NSApp.activate()
    }

    // MARK: - Appearance

    private func applyPalette() {
        window?.backgroundColor = .hsl(palette.base)
        webShell?.webView.underPageBackgroundColor = .hsl(palette.base)
        effectView?.appearance = Self.vibrancyAppearance(palette)
        launchModel.palette = palette
    }

    /// The vibrancy follows the page theme, not the macOS appearance.
    private static func vibrancyAppearance(_ palette: LaunchPalette) -> NSAppearance? {
        NSAppearance(named: palette.isLight ? .aqua : .darkAqua)
    }

    private func observeAccentColor() {
        appearanceObserver = NSApp.observe(\.effectiveAppearance, options: [.new]) { [weak self] _, _ in
            Task { @MainActor in self?.resolveNativeSettingsAppearance() }
        }
        accentObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("AppleColorPreferencesChangedNotification"), object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.accentColorDidChange() }
        }
    }

    private func accentColorDidChange() {
        resolveNativeSettingsAppearance()
        guard queue.isReady else { return }
        deliver(.accentColorChanged, accentColor().map(JSONValue.string) ?? .null)
    }

    // MARK: - BridgeHost

    func rendererDidFail(_ failure: RendererFailure) {
        let location = failure.line > 0 ? "\(failure.source):\(failure.line)" : failure.source
        logger.error(
            "[renderer] \(failure.kind, privacy: .public) (\(failure.name, privacy: .public)) at \(location, privacy: .public)"
        )
    }

    func rendererDidBecomeReady() {
        guard let document = rendererReadiness.markReady() else { return }
        for message in queue.markReady() { evaluate(message.event, message.payload) }
        deliver(.menuAction, BridgeDispatcher.menuActionPayload(.nativeSidebar(visible: shellModel.isSidebarVisible)))
        let rendererGeneration = nativeSettingsGeneration
        Task { [weak self] in
            guard let self, self.rendererReadiness.isCurrentReady(document),
                rendererGeneration == self.nativeSettingsGeneration
            else { return }
            // Native restore applies frontend state and acknowledges onboarding
            // before its delayed reload. Normal reload also owns its full drain.
            guard !self.restoreFenceEntered, self.pendingRestoreReload != rendererGeneration,
                self.manualReloadTask == nil, self.nativeSettingsRebuildTask == nil
            else { return }
            // Legacy web restore owns navigation itself. Its next ready document
            // reconstructs the retired native graph without another web reload.
            if self.restoredNativeGeneration == rendererGeneration {
                do { try await self.rebuildNativeSettingsGraph(expectedGeneration: rendererGeneration) } catch {
                    return
                }
            }
            let generation = self.nativeSettingsGeneration
            let model = self.shellModel
            let isCurrentStartup = {
                self.rendererReadiness.isCurrentReady(document)
                    && generation == self.nativeSettingsGeneration && model === self.shellModel
                    && !self.restoreFenceEntered && self.pendingRestoreReload == nil
                    && self.restoredNativeGeneration == nil && self.manualReloadTask == nil
                    && self.nativeSettingsRebuildTask == nil
            }
            guard isCurrentStartup() else { return }
            model.isRendererReady = true
            model.isReloadingGraph = false
            await self.loadNativeSettingsLegacyTheme(document: document)
            guard isCurrentStartup() else { return }
            await model.nativeSettings?.load()
            guard isCurrentStartup() else { return }
            await model.onboarding?.load()
            guard isCurrentStartup() else { return }
            if let onboarding = model.onboarding {
                self.publishNativeOnboarding(model: onboarding, generation: generation)
            }
            for (key, value) in self.nativeSettingsDrafts {
                self.publishNativeSettings(kind: "draft", key: key, value: value)
            }
            self.publishNativeSettingsSession()
            self.resolveNativeSettingsAppearance()
            self.startNativeSettingsAppearanceWatch()
            guard self.documentSelection != .retainedWeb else {
                model.reloadSettings()
                return
            }
            // Helper mode owns StartupRedirect: capture its two raw values before tracking
            // overwrites them, then resolve once from the mirror or the loaded settings.
            let mirror = try? await self.nativeLocalValue(.startupSection, generation: generation)
            let lastRoute = try? await self.nativeLocalValue(.lastRoute, generation: generation)
            guard isCurrentStartup() else { return }
            var startup = NativeNavigationStartup(
                context: self.helperStartupResolved ? .documentReload : .newSession,
                mirroredStartupSection: mirror ?? nil, lastRoute: lastRoute ?? nil)
            self.helperStartupResolved = true
            self.applyHelperStartup(&startup, model: model)
            model.reloadSettings()
            // Queued cold and menu intents wait for document, settings and onboarding.
            model.nativeIntentReadinessDidChange()
            await model.settingsSettled()
            guard isCurrentStartup() else { return }
            self.applyHelperStartup(&startup, model: model)
            model.nativeIntentReadinessDidChange()
            self.persistHelperNavigation(model: model, generation: generation)
            self.trackHelperNavigation(model: model, generation: generation)
        }
        revealWebView()
    }

    func setDockBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = DockBadge.label(for: count)
    }

    /// `app:set-language`: a request for the active language still supersedes an older
    /// one that is loading.
    func setLanguage(_ language: NativeLanguage) async -> LanguageChange {
        languageRequest += 1
        let request = languageRequest
        if strings.language == language { return .applied }
        let directory = Self.localeDirectory
        let loaded = await Task.detached { ShellStrings.load(language: language, directory: directory) }.value
        guard request == languageRequest else { return .superseded }
        strings = loaded
        launchModel.strings = loaded
        shellModel.strings = CatalogStrings(language: language)
        shellModel.onboarding?.strings = shellModel.strings
        do {
            try await supervisor.updateSettings { $0["nativeLanguage"] = .string(language.rawValue) }
        } catch {
            logger.warning("nativeLanguage save failed (non-fatal): \(error.localizedDescription, privacy: .public)")
        }
        guard request == languageRequest else { return .superseded }
        installMenus()
        updateHelperDocumentLocale()
        return .applied
    }

    func setVibrancy(_ enabled: Bool) -> Bool {
        guard let effectView, let webView = webShell?.webView else { return false }
        effectView.isHidden = !enabled
        webView.setDrawsPageBackground(!enabled)
        return true
    }

    func accentColor() -> String? {
        guard let color = NSColor.controlAccentColor.usingColorSpace(.sRGB) else { return nil }
        return AccentColor.hex(
            red: Double(color.redComponent), green: Double(color.greenComponent), blue: Double(color.blueComponent),
            alpha: Double(color.alphaComponent))
    }

    func persistSplashTheme(_ theme: SplashTheme) async -> Bool {
        if shellModel.nativeSettings?.isLoaded == true {
            resolveNativeSettingsAppearance()
            return true
        }
        let value = theme.jsonValue
        do {
            try await supervisor.updateSettings { $0[LaunchAppearance.splashThemeKey] = value }
        } catch {
            logger.warning("theme:persist-splash failed (non-fatal): \(error.localizedDescription, privacy: .public)")
            return false
        }
        palette = LaunchAppearance.palette(theme: theme)
        applyPalette()
        let systemIsDark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        var selection = ThemeSelection.resolve(splashTheme: theme, systemIsDark: systemIsDark)
        selection.colorblindGainLoss = shellModel.theme.colorblindGainLoss
        shellModel.theme = selection
        return true
    }

    func saveServicesSettings(keepServicesOnQuit: Bool) async throws {
        let supervisor = self.supervisor
        try await ServicesSettings.save(
            keepServicesOnQuit: keepServicesOnQuit, baseURL: appURL, writer: settingsWriter,
            mirror: { keep in
                try await supervisor.updateSettings { $0["keepServicesOnQuit"] = .bool(keep) }
            })
    }

    func saveBackupSettings(_ settings: BackupSettingsValue) async throws {
        let supervisor = self.supervisor
        try await BackupSettings.save(
            settings, baseURL: appURL, writer: settingsWriter,
            mirror: { value in
                try await supervisor.updateSettings {
                    $0["backupDir"] = .string(value.backupDir)
                    $0["backupOnQuit"] = .bool(value.backupOnQuit)
                }
            })
    }

    func loadBackupSettings() async -> BackupSettingsValue {
        let supervisor = self.supervisor
        return await BackupSettings.load(
            baseURL: appURL, transport: settingsTransport, writer: settingsWriter,
            mirror: { value in
                _ = try? await supervisor.updateSettings {
                    $0["backupDir"] = .string(value.backupDir)
                    $0["backupOnQuit"] = .bool(value.backupOnQuit)
                }
            },
            fallback: { await supervisor.currentSettings() },
            defaultDirectory: backupService.defaultICloudBackupDirectory)
    }

    // MARK: - Backup and restore

    func runBackup(destination: String, frontendStateJson: String?) async -> JSONValue {
        await backupService.runBackup(destination: destination, frontendStateJson: frontendStateJson)
    }

    /// `backup:select-dir`: a folder picker starting in iCloud Drive (else Documents).
    func selectBackupDirectory() async -> String? {
        let panel = NSOpenPanel()
        panel.title = "Select Backup Directory"
        panel.prompt = "Choose"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        let start = backupService.pickerDefaultDirectory
        if FileManager.default.fileExists(atPath: start) {
            panel.directoryURL = URL(fileURLWithPath: start, isDirectory: true)
        }
        guard await runPanel(panel) == .OK, let url = panel.url else { return nil }
        return url.path
    }

    /// `backup:select-file`: the chosen file joins the restore allow-list.
    func selectRestoreFile() async -> String? {
        let panel = NSOpenPanel()
        panel.title = "Select Backup File to Restore"
        panel.prompt = "Restore"
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        // Electron's filters, "Vision Backup" (visionbak, enc, sql) and "All Files", as a
        // pop-up in the accessory view; NSOpenPanel has no filter menu of its own.
        panel.allowedContentTypes = ["visionbak", "enc", "sql"].compactMap { UTType(filenameExtension: $0) }
        panel.accessoryView = allFilesAccessory(for: panel)
        panel.isAccessoryViewDisclosed = true
        guard await runPanel(panel) == .OK, let url = panel.url else { return nil }
        return restorePathAllowList.add(url.path)
    }

    /// A "Show: Vision Backup / All Files" pop-up, Electron's two file filters.
    private func allFilesAccessory(for panel: NSOpenPanel) -> NSView {
        let label = NSTextField(labelWithString: "Show:")
        let popUp = NSPopUpButton(frame: .zero, pullsDown: false)
        popUp.addItems(withTitles: ["Vision Backup", "All Files"])
        let types = panel.allowedContentTypes
        popUp.target = FileTypeFilterTarget.shared
        popUp.action = #selector(FileTypeFilterTarget.changed(_:))
        FileTypeFilterTarget.shared.attach(panel: panel, types: types)
        let stack = NSStackView(views: [label, popUp])
        stack.orientation = .horizontal
        stack.spacing = 8
        stack.edgeInsets = NSEdgeInsets(top: 8, left: 12, bottom: 8, right: 12)
        return stack
    }

    /// A sheet on the window when it is visible, else an app-modal panel.
    private func runPanel(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        guard let window, window.isVisible else { return panel.runModal() }
        return await withCheckedContinuation {
            (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            panel.beginSheetModal(for: window) { response in continuation.resume(returning: response) }
        }
    }

    func isBackupEncrypted(_ path: String) async -> Bool {
        await backupService.isEncrypted(path)
    }

    /// `backup:restore`: the localized confirmation, then the restore, which stops and
    /// restarts the backend itself.
    func restoreBackup(_ path: String, passphrase: String?) async -> JSONValue {
        await restoreNativeBackup(path, passphrase: passphrase, onboardingRestore: false, nativeReloadOwned: false)
    }

    private func restoreNativeBackup(
        _ path: String, passphrase: String?, onboardingRestore: Bool, nativeReloadOwned: Bool
    ) async -> JSONValue {
        guard !restoreFenceEntered, pendingRestoreReload == nil, !shellModel.isReloadingGraph else {
            return .object(["success": .bool(false), "error": .string("A restore is already in progress")])
        }
        let operation = UUID()
        let fileName = (path as NSString).lastPathComponent
        // `stopHealthWatchdog` stops the closure timer for the restore;
        // `startHealthWatchdog` starts it again.
        auditChannels.stopClosureTimer()
        let result = await backupService.restore(
            path: path, passphrase: passphrase,
            confirm: { [weak self] in
                await self?.confirmAndSuspendForRestore(fileName: fileName, operation: operation) ?? false
            },
            confirmAuditRecovery: { [weak self] status in
                await self?.confirmAuditRecovery(fileName: fileName, auditStatus: status) ?? false
            })
        if restoreFenceEntered, restoreFenceOwner == operation {
            if result["success"] == .bool(true) {
                restoredNativeGeneration = nativeSettingsGeneration
                if nativeReloadOwned {
                    pendingRestoreReload = nativeSettingsGeneration
                    restoredFrontendSession = NativeLocalStateSession()
                    restoredCompletionDataSession = NativeDataSession()
                }
                await localStateSession.retireForReload()
                if onboardingRestore, shellModel.onboarding?.isPresented == true {
                    onboardingRestoreIntent = nativeSettingsGeneration
                }
                shellModel.commandPalette?.retireForReload()
                shellModel.shellNotifications?.didDisappear()
                shellModel.reports?.retireForReload()
                shellModel.nativeSettings?.retireForReload()
                await settingsWriter.retireForReload()
                await dataSession.retireForReload()
            } else {
                await localStateSession.resumeAfterFailedRestore()
                shellModel.nativeSettings?.resumeAfterFailedRestore()
                await settingsWriter.resumeAfterFailedRestore()
                await dataSession.resumeAfterFailedRestore()
                shellModel.isRendererReady = queue.isReady
                if let onboarding = shellModel.onboarding {
                    publishNativeOnboarding(model: onboarding, generation: nativeSettingsGeneration)
                }
                for (key, value) in nativeSettingsDrafts {
                    publishNativeSettings(kind: "draft", key: key, value: value)
                }
                publishNativeSettingsSession()
            }
            restoreFenceEntered = false
            restoreFenceOwner = nil
        }
        if result["auditStatus"]?.stringValue == "unavailable" {
            auditChannels.report("unavailable")
        }
        await auditChannels.startClosureTimer()
        return result
    }

    private func confirmAndSuspendForRestore(fileName: String, operation: UUID) async -> Bool {
        guard !restoreFenceEntered, pendingRestoreReload == nil, !shellModel.isReloadingGraph,
            await confirmRestore(fileName: fileName), !restoreFenceEntered, pendingRestoreReload == nil,
            !shellModel.isReloadingGraph
        else { return false }
        restoreFenceEntered = true
        restoreFenceOwner = operation
        shellModel.isRendererReady = false
        await shellModel.nativeSettings?.suspendForRestore()
        await settingsWriter.suspendAndDrain()
        shellModel.closePalette()
        shellModel.closeShortcuts()
        await drainNativeLocalWrites(shellModel)
        await localStateSession.suspendAndDrain()
        if let streams = shellModel.aiChat?.chat.streams {
            for id in streams.activeIDs { streams.stop(id: id) }
        }
        shellModel.imports.cancelImport()
        shellModel.portfolioImports?.advanced.cancel()
        await dataSession.suspendAndDrain()
        // Late mutation receipts wait at the paused local session. A failed
        // restore resumes them; success retires them before frontend state changes.
        return true
    }

    private func drainNativeLocalWrites(_ model: NativeShellModel) async {
        await model.commandPalette?.flushRecents()
        await model.onboarding?.flushDraft()
        await model.shellNotifications?.flushStorage()
        await model.home?.flushLocalStorage()
        await model.researchChartBuilder?.flushStorage()
        await model.analysis?.workspace.flushHistory()
        await model.portfolioImports?.session.flushCheckpoint()
    }

    private func confirmRestore(fileName: String) async -> Bool {
        await confirm(
            AuditConfirmation(
                title: strings.t("settings.restore.title", fallback: "Restore Backup"),
                message: strings.t(
                    "settings.restore.warning",
                    fallback: "This will permanently replace all current data and cannot be undone."),
                detail: fileName,
                confirmLabel: strings.t("settings.restore.runNow", fallback: "Restore"),
                cancelLabel: strings.t("settings.restore.cancelButton", fallback: "Cancel")))
    }

    /// The second warning of `restoreWithAuditRecovery`.
    private func confirmAuditRecovery(fileName: String, auditStatus: String?) async -> Bool {
        await auditChannels.confirmAuditRecovery(fileName: fileName, auditStatus: auditStatus)
    }

    // MARK: - Audit

    func enrollAudit() async -> JSONValue { await auditChannels.enroll() }
    func readAudit(_ range: AuditViewer.ReadRange) async -> JSONValue { await auditChannels.read(range) }
    func exportAuditSnapshot() async -> JSONValue { await auditChannels.exportSnapshot() }
    func exportAuditTransfer(password: String) async -> JSONValue {
        await auditChannels.exportTransfer(password: password)
    }
    func importAuditTransfer(password: String) async -> JSONValue {
        await auditChannels.importTransfer(password: password)
    }
    func rotateAuditKey() async -> JSONValue { await auditChannels.rotateKey() }

    /// A warning alert, as a sheet when the window is visible; Cancel is the default
    /// button (`defaultId: 1, cancelId: 1`).
    func confirm(_ confirmation: AuditConfirmation) async -> Bool {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = confirmation.title
        alert.informativeText = [confirmation.message, confirmation.detail].compactMap { $0 }.joined(separator: "\n\n")
        let accept = alert.addButton(withTitle: confirmation.confirmLabel)
        let cancel = alert.addButton(withTitle: confirmation.cancelLabel)
        accept.keyEquivalent = ""
        cancel.keyEquivalent = "\r"
        showWindow()
        let response: NSApplication.ModalResponse
        if let window, window.isVisible {
            response = await withCheckedContinuation {
                (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
                alert.beginSheetModal(for: window) { continuation.resume(returning: $0) }
            }
        } else {
            response = alert.runModal()
        }
        return response == .alertFirstButtonReturn
    }

    /// The export card's file: a Save panel with the suggested name, then the bytes are
    /// written. `false` when the user cancels.
    private func saveExport(_ data: Data, suggestedName: String) async throws -> Bool {
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.nameFieldStringValue = suggestedName
        let fileExtension = (suggestedName as NSString).pathExtension
        if let type = UTType(filenameExtension: fileExtension) { panel.allowedContentTypes = [type] }
        guard await runPanel(panel) == .OK, let url = panel.url else { return false }
        try data.write(to: url, options: .atomic)
        return true
    }

    private func pickResearchDocument() async throws -> AIResearchDocumentFile? {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.plainText, .html] + [UTType(filenameExtension: "md")].compactMap { $0 }
        guard await runPanel(panel) == .OK, let url = panel.url else { return nil }
        let accessing = url.startAccessingSecurityScopedResource()
        defer { if accessing { url.stopAccessingSecurityScopedResource() } }
        let values = try url.resourceValues(forKeys: [.fileSizeKey, .contentTypeKey])
        let maximumBytes = 5 * 1024 * 1024
        guard (values.fileSize ?? 0) <= maximumBytes else {
            throw APIError.invalidRequest("Document exceeds the 5 MiB upload limit")
        }
        let data = try Data(contentsOf: url, options: .mappedIfSafe)
        guard data.count <= maximumBytes else {
            throw APIError.invalidRequest("Document exceeds the 5 MiB upload limit")
        }
        return AIResearchDocumentFile(
            name: url.lastPathComponent, contentType: values.contentType?.preferredMIMEType ?? "text/plain", data: data)
    }

    /// `dialog.showSaveDialog`.
    func chooseSaveLocation(_ request: AuditFilePanel) async -> String? {
        let panel = NSSavePanel()
        panel.title = request.title
        panel.canCreateDirectories = true
        if let name = request.defaultName { panel.nameFieldStringValue = name }
        panel.allowedContentTypes = request.extensions.compactMap { UTType(filenameExtension: $0) }
        guard await runPanel(panel) == .OK, let url = panel.url else { return nil }
        return url.path
    }

    /// `dialog.showOpenDialog` with one file.
    func chooseFile(_ request: AuditFilePanel) async -> String? {
        let panel = NSOpenPanel()
        panel.title = request.title
        panel.canChooseDirectories = false
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = request.extensions.compactMap { UTType(filenameExtension: $0) }
        guard await runPanel(panel) == .OK, let url = panel.url else { return nil }
        return url.path
    }

    /// Electron's `notify`. Vision Native has no notification entitlement, so the notice
    /// goes to the log (done by `AuditChannels`) and, while the window is visible, to a
    /// non-blocking informational sheet.
    func showAuditNotice(_ message: String) {
        guard let window, window.isVisible, window.attachedSheet == nil else { return }
        let alert = NSAlert()
        alert.alertStyle = .informational
        alert.messageText = Self.appName
        alert.informativeText = message
        alert.beginSheetModal(for: window, completionHandler: nil)
    }

    func backupEncryptionStatus() async -> PassphraseStatus {
        await backupService.encryptionStatus()
    }

    func setBackupPassphrase(_ passphrase: String) async -> PassphraseUpdateResult {
        await backupService.setPassphrase(passphrase)
    }

    func loadServicesSettings() async -> Bool {
        let supervisor = self.supervisor
        return await ServicesSettings.load(
            baseURL: appURL, transport: settingsTransport, writer: settingsWriter,
            mirror: { keep in
                _ = try? await supervisor.updateSettings { $0["keepServicesOnQuit"] = .bool(keep) }
            },
            fallback: {
                AppSettings.keepServicesFromSettings(await supervisor.currentSettings())
            })
    }

    func retryLaunch() {
        launch()
    }

    func openLogs() throws -> String {
        let path = supervisor.logsDirectory
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        guard NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true)) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: path])
        }
        return path
    }

    func startWindowDrag() {
        // performDrag needs the mouse-down that started it, and only while the button is held.
        guard let window, let event = webShell?.webView.lastMouseDown, NSEvent.pressedMouseButtons & 1 == 1,
            ProcessInfo.processInfo.systemUptime - event.timestamp < 2
        else {
            return
        }
        window.performDrag(with: event)
    }

    func routeDidChange(_ route: NativeRoute) {
        shellModel.routeDidChange(route)
    }

    func routeDidChange(_ route: NativeRoute, onboardingPresented: Bool) {
        shellModel.isPresentingOnboarding = onboardingPresented
        shellModel.routeDidChange(route)
    }

    func changeNativeSettings(_ patch: NativeSettingsPatch) async throws {
        guard !shellModel.isReloadingGraph else { throw CancellationError() }
        let generation = nativeSettingsGeneration
        guard let model = shellModel.nativeSettings else { throw APIError.backendUnavailable }
        await model.load()
        guard model.isLoaded, generation == nativeSettingsGeneration else { throw APIError.backendUnavailable }
        guard !model.isSuspendedForRestore, !shellModel.isReloadingGraph else {
            throw APIError.invalidRequest("Settings are paused during restore or reload")
        }
        let raw = try JSONDecoder().decode(TaxValue.self, from: JSONEncoder().encode(JSONValue.object(patch.updates)))
        guard var fields = raw.objectValue else { throw APIError.invalidRequest("Invalid native settings patch") }
        switch patch.key {
        case "app_settings":
            for key in patch.removed { fields[key] = .null }
            model.updateApp(fields)
        case "dashboard_settings": model.updateDashboard(fields)
        case "theme_settings":
            if let schedule = fields.removeValue(forKey: "schedule") {
                guard let updates = schedule.objectValue,
                    Set(updates.keys).isSubset(of: ["lightFrom", "darkFrom"])
                else {
                    throw APIError.invalidRequest("Invalid theme schedule")
                }
                model.updateThemeSchedule(updates)
            }
            if !fields.isEmpty { model.updateTheme(fields) }
        default: throw APIError.invalidRequest("Unsupported native settings key")
        }
    }

    func openNativeOverlay(_ kind: NativeShellOverlayKind) async throws {
        guard !restoreFenceEntered, restoredNativeGeneration == nil,
            !shellModel.isReloadingGraph, shellModel.nativeSettings?.isSuspendedForRestore != true
        else { throw APIError.invalidRequest("Native overlays are paused during restore") }
        guard queue.isReady, shellModel.nativeSettings?.isLoaded == true else { throw APIError.backendUnavailable }
        switch kind {
        case .palette:
            guard shellModel.commandPalette != nil else { throw APIError.backendUnavailable }
            shellModel.openPalette()
        case .shortcuts: shellModel.openShortcuts()
        case .settings, .report, .onboarding: throw APIError.invalidRequest("Unsupported native overlay")
        }
    }

    func titlebarDoubleClicked() {
        guard let window else { return }
        switch TitlebarDoubleClickAction.from(
            userDefault: UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick"))
        {
        case .zoom: window.performZoom(nil)
        case .minimize: window.performMiniaturize(nil)
        case .none: break
        }
    }
}

/// Applies the restore picker's file-type pop-up: index 0 keeps the backup types, index 1
/// allows every file.
@MainActor
final class FileTypeFilterTarget: NSObject {
    static let shared = FileTypeFilterTarget()
    private weak var panel: NSOpenPanel?
    private var types: [UTType] = []

    func attach(panel: NSOpenPanel, types: [UTType]) {
        self.panel = panel
        self.types = types
    }

    @objc func changed(_ sender: NSPopUpButton) {
        panel?.allowedContentTypes = sender.indexOfSelectedItem == 1 ? [] : types
    }
}

/// Backup log lines go to the unified log next to the shell's own.
struct OSLogRuntimeLog: RuntimeLogging {
    let logger: Logger

    func log(_ level: String, _ message: String) {
        switch level {
        case "error": logger.error("\(message, privacy: .public)")
        case "warn": logger.warning("\(message, privacy: .public)")
        default: logger.info("\(message, privacy: .public)")
        }
    }
}

extension NSColor {
    static func hsl(_ color: HSLColor, alpha: Double = 1) -> NSColor {
        let rgb = color.rgb
        return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: alpha)
    }
}
