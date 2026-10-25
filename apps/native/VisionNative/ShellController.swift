import AppKit
import OSLog
import Observation
import PDFKit
import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore
import VisionNativeUI

/// Owns the window, menus, dock and the native shell (`ShellRootView`): the launch state, the
/// per-device storage behind the native screens, the backup and restore workflow, and the
/// main-process side of packaging/electron/main.ts.
@MainActor
final class ShellController: NSObject, NSWindowDelegate {
    /// "Vision Native" or "Vision Native Demo" (`APP_NAME`).
    static var appName: String { AppRuntime.variant.appName }

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
    /// Lets the backup service reach this controller around a backup snapshot; set after `init`.
    private let backupMaintenance: BackupMaintenanceRelay
    /// The typed API client of native screens (`client.ts`).
    private lazy var apiClient = makeAPIClient()
    private var dataSession = NativeDataSession()
    private var localStateSession = NativeLocalStateSession()
    /// The raw-state store behind the shell's per-device storage; `nil` until the backend is ready.
    private var nativeStorage: NativeShellStorage?
    /// The applied page zoom, kept across graph rebuilds.
    private var currentPageZoom: Double
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
    /// The SwiftUI shell (sidebar and detail).
    private var shellHost: NSView?
    /// The backend base URL native requests use; `nil` until the runtime is ready.
    private(set) var appURL: URL?
    private var hasMadeShellModel = false
    private var healthWatchdogTask: Task<Void, Never>?
    /// One request log for the app's lifetime, across graph rebuilds, as the web's module store.
    private let apiInspector = NativeAPIInspectorModel()
    private let backendNoticeSource = UUID()
    private var backendNoticeID: UUID?
    /// Cold CSV, new-transaction and menu intents, retained across graph rebuilds so committed
    /// history and unconsumed intents survive (ADR-210, ADR-211).
    private let nativeIntents = NativeShellIntentCoordinator()
    /// The first native startup seeds a new session; later documents are reloads.
    private var nativeStartupResolved = false
    /// A new value per document start: a startup task acts only while its value is current.
    private var documentGeneration = UUID()
    /// Whether this graph's document may use the storage and run its startup.
    private var isDocumentReady = false
    private var launchTask: Task<Void, Never>?
    private var startTask: Task<Void, Never>?
    /// Electron's `notify`, for the launch and quit notices.
    private lazy var notifier = SystemNotifier(appName: Self.appName, logger: logger)
    /// Set when a launch or Retry reaches the backend; the reveal that follows posts
    /// `app.running`, as `pollAndLoad` does once the application has loaded.
    private var announceRunning = false
    private var frameSaveTask: Task<Void, Never>?
    private var languageRequest = 0
    private var accentObserver: NSObjectProtocol?
    private var appearanceObserver: NSKeyValueObservation?
    private var nativeSettingsGeneration = UUID()
    private var settingsAppearanceTask: Task<Void, Never>?
    private var lastSettingsClockRefresh = Date.distantPast
    private var lastSettingsDisplayPixels: Double?
    private var lastSettingsSystemIsDark: Bool?

    private func makeAPIClient(session: NativeDataSession? = nil, timeout: TimeInterval = 30) -> APIClient {
        let transport = URLSessionAPITransport()
        let inspected = NativeAPIInspectorTransport(base: transport, inspector: apiInspector)
        let fenced = NativeSessionAPITransport(base: inspected, streamBase: transport, session: session ?? dataSession)
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
        let paletteRates = NativePaletteRates(load: { try await client.exchangeRates() })
        let commandPalette = NativeCommandPaletteModel(
            service: client,
            answers: NativeCommandPaletteAnswerProvider { [weak self] query, format, currency, decimals in
                guard let self else { throw APIError.backendUnavailable }
                return try await self.nativePaletteAnswer(
                    query: query, format: format, currency: currency, decimals: decimals, rates: paletteRates,
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
            self.resolveNativeSettingsAppearance()
            if let language = NativeLanguage(rawValue: settings.language) {
                Task { [weak self] in await self?.setLanguage(language) }
            }
        }
        nativeSettings.didChangeTheme = { [weak self] raw in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
            self.resolveNativeSettingsAppearance()
        }
        nativeSettings.didAcknowledge = { [weak self] key, value in
            guard let self, self.nativeSettingsGeneration == settingsGeneration else { return }
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
                service: client, database: client, token: makeAdminTokenAccess(generation: settingsGeneration)),
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
            initialRoute: initialRoute,
            // Native history owns every route (ADR-209).
            nativeNavigation: NativeNavigationHistory(initial: NativeNavigationLocation(initialRoute.string) ?? .home),
            nativeIntents: nativeIntents,
            hiddenSections: Self.loadHiddenSections(),
            loadSettings: {
                await nativeSettings.load()
                return try await MainActor.run {
                    guard nativeSettings.isLoaded else { throw APIError.backendUnavailable }
                    return NativeAppSettings.migrate(try JSONValue(encoding: nativeSettings.appRaw ?? .object([:])))
                }
            },
            saveHiddenSections: { Self.saveHiddenSections($0) },
            copyToClipboard: { value in
                NSPasteboard.general.clearContents()
                return NSPasteboard.general.setString(value, forType: .string)
            },
            onSidebarVisibilityChange: { visible in
                UserDefaults.standard.set(!visible, forKey: Self.sidebarCollapsedKey)
            })
        // `vision.sidebar.collapsed`: the sidebar comes back as it was left.
        if UserDefaults.standard.bool(forKey: Self.sidebarCollapsedKey) { model.setSidebarVisible(false) }
        model.reloadPage = { [weak self] in self?.run(.reload) }
        model.sidebarBadges = NativeSidebarBadgesModel(service: client)
        model.apiInspector = apiInspector
        // The document start publishes readiness only after verifying this graph's generation.
        model.setPageZoom(currentPageZoom)
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
                try? await self?.clearDashboardArrival(generation: settingsGeneration)
            }
        }
        observeNativeSettingsSession(model: model, generation: settingsGeneration)
        return model
    }

    private func requireNativeGeneration(_ generation: UUID, allowRestored: Bool = false) throws {
        guard generation == nativeSettingsGeneration,
            allowRestored || restoredNativeGeneration != generation
        else { throw CancellationError() }
    }

    private func nativeLocalValue(_ key: NativeRawStateStore.LocalKey, generation: UUID) async throws -> String? {
        try requireNativeGeneration(generation)
        let session = localStateSession
        try await session.checkRead()
        guard isDocumentReady, let storage = nativeStorage else { throw CancellationError() }
        let value = await storage.value(for: key)
        guard isDocumentReady else { throw CancellationError() }
        try requireNativeGeneration(generation)
        try await session.checkRead()
        return value
    }

    private func writeNativeLocalValue(
        _ value: String?, key: NativeRawStateStore.LocalKey, generation: UUID, allowRestored: Bool = false
    ) async throws {
        try requireNativeGeneration(generation, allowRestored: allowRestored)
        guard isDocumentReady, let storage = nativeStorage else { throw APIError.backendUnavailable }
        let session: NativeLocalStateSession?
        if allowRestored {
            // A restored backup's draft clear runs on the restore-only session; the old graph's
            // admission is already retired.
            guard pendingRestoreReload == generation, let restored = restoredFrontendSession else {
                throw CancellationError()
            }
            session = restored
        } else {
            session = nil
        }
        try await performStorageWrite(
            in: session,
            validate: {
                try requireNativeGeneration(generation, allowRestored: allowRestored)
                if allowRestored, pendingRestoreReload != generation { throw CancellationError() }
            }
        ) {
            do { try await storage.setValue(value, for: key) } catch { throw APIError.backendUnavailable }
        }
        try requireNativeGeneration(generation, allowRestored: allowRestored)
    }

    /// One storage mutation under the local-state session's write admission: a restore or reload
    /// waits for it, and a paused session refuses it. `validate` re-checks the graph once the
    /// admission is granted; the admission is released however `body` ends. The raw-state store's
    /// own completion is the physical completion the fences wait for.
    private func performStorageWrite<T>(
        in session: NativeLocalStateSession? = nil, validate: () throws -> Void = {},
        _ body: () async throws -> T
    ) async throws -> T {
        let session = session ?? localStateSession
        let token = try await session.beginWrite()
        do {
            try Task.checkCancellation()
            try validate()
            let result = try await body()
            await session.finishWrite(token)
            return result
        } catch {
            await session.finishWrite(token)
            throw error
        }
    }

    /// The backup's `{ keys }` over the backup registry, from the raw-state store.
    private func captureBackupState() async throws -> String? {
        guard isDocumentReady, let storage = nativeStorage else { throw APIError.backendUnavailable }
        do { return try await storage.backupStateJSON() } catch { throw APIError.backendUnavailable }
    }

    /// A restored backup's local values, written on the restore-only session.
    private func applyRestoredBackupState(_ state: JSONValue, generation: UUID) async throws {
        guard pendingRestoreReload == generation, generation == nativeSettingsGeneration, isDocumentReady,
            let storage = nativeStorage, let session = restoredFrontendSession
        else { throw CancellationError() }
        let applied = try await performStorageWrite(
            in: session,
            validate: {
                guard generation == nativeSettingsGeneration, pendingRestoreReload == generation else {
                    throw CancellationError()
                }
            }
        ) {
            await storage.restore(state)
        }
        guard applied else { throw APIError.backendUnavailable }
    }

    /// Onboarding completion resets the dashboard's arrival flag.
    private func clearDashboardArrival(generation: UUID) async throws {
        try requireNativeGeneration(generation)
        guard isDocumentReady, let storage = nativeStorage else { return }
        try await performStorageWrite(validate: { try requireNativeGeneration(generation) }) {
            await storage.clearDashboardArrival()
        }
    }

    /// The palette's inline answers, computed natively (ADR-211); rates come from the
    /// graph's shared 10-minute cache.
    private func nativePaletteAnswer(
        query: String, format: NumberFormat, currency: String, decimals: Int, rates: NativePaletteRates,
        generation: UUID
    ) async throws -> NativeCommandPaletteAnswer? {
        try requireNativeGeneration(generation)
        let answer = await NativePaletteCalculator.answer(
            query: query, format: format, currency: currency, decimals: decimals, readRates: { await rates.read() })
        try requireNativeGeneration(generation)
        return answer
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
        // ADR-211: the overview and the native projection; no helper document is involved.
        let context = NativeTaxReportContextService(
            client: apiClient, localize: { [weak self] key in self?.shellModel.strings.t(key) ?? key })
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
        onboardingRestoreIntent = nil
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
                return try await self.captureBackupState()
            },
            runBackup: { [weak self] directory, state in
                await self?.runBackup(destination: directory, frontendStateJson: state)
            },
            isBackupEncrypted: { [weak self] path in await self?.isBackupEncrypted(path) ?? false },
            restoreBackup: { [weak self] path, passphrase in
                guard let self else { return nil }
                try self.requireNativeGeneration(generation)
                return await self.restoreNativeBackup(
                    path, passphrase: passphrase, onboardingRestore: onboardingRestore)
            },
            applyRestoredFrontendState: { [weak self] state in
                guard let self else { throw APIError.backendUnavailable }
                try await self.applyRestoredBackupState(state, generation: generation)
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
                return try await self.nativeLocalValue(.backupReminder, generation: generation) == "1"
            },
            writeBackupReminder: { [weak self] dismissed in
                guard let self else { throw APIError.backendUnavailable }
                try await self.writeNativeLocalValue(
                    dismissed ? "1" : nil, key: .backupReminder, generation: generation)
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
        chat.chat.didReceiveStatus = { [weak settings] receipt in
            settings?.seedSharedStatus(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        chat.chat.didReceiveModels = { [weak settings] receipt in
            settings?.seedSharedModels(receipt.value, fetchedAt: receipt.fetchedAt)
        }
        settings.didInvalidateSharedReads = { [weak chat] keys in
            chat?.chat.invalidateSharedAIReads(keys)
        }
        chat.chat.didInvalidateSharedReads = { [weak settings] keys in settings?.invalidateSharedAIReads(keys) }
    }

    private func observeNativeSettingsSession(model: NativeShellModel, generation: UUID) {
        withObservationTracking {
            _ = model.nativeSettings?.sessionTierOverride
            _ = model.nativeSettings?.isLoaded
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model, generation == self.nativeSettingsGeneration else { return }
                self.resolveNativeSettingsAppearance()
                self.observeNativeSettingsSession(model: model, generation: generation)
            }
        }
    }

    /// The web app's theme keys, which only a restored backup can carry now; the settings model
    /// migrates them when the theme settings hold none.
    private func loadNativeSettingsLegacyTheme(document: UUID, storage: NativeShellStorage) async {
        guard let model = shellModel.nativeSettings else { return }
        let generation = nativeSettingsGeneration
        let stored = await storage.legacyTheme()
        guard generation == nativeSettingsGeneration, document == documentGeneration, !restoreFenceEntered,
            pendingRestoreReload == nil, restoredNativeGeneration == nil
        else { return }
        var legacy: [String: TaxValue] = [:]
        if let mode = stored.mode, ["light", "dark"].contains(mode) { legacy["mode"] = .string(mode) }
        if let variant = stored.variant, ThemeVariant(rawValue: variant) != nil {
            legacy["variant"] = .string(variant)
        }
        model.legacyTheme = legacy.isEmpty ? nil : .object(legacy)
        if model.isLoaded { await model.load(force: true) }
    }

    private func resolveNativeSettingsAppearance() {
        // Reading `shellModel` builds the graph; appearance must not do that before launch has
        // built it (the accent observer runs at start).
        guard hasMadeShellModel, let settings = shellModel.nativeSettings, settings.isLoaded else { return }
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
        // ElectronBridge's effect: vibrancy only on the effective 'enhanced' tier.
        setVibrancy(resolved.effectiveVisualEffects == "enhanced")
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
        guard nativeStorage != nil else { throw APIError.backendUnavailable }
        if let session = restoredCompletionDataSession {
            await session.suspendAndDrain()
            await session.retireForReload()
        }
        if let session = restoredFrontendSession {
            // Accepted restore writes drain before the session retires.
            await session.suspendAndDrain()
            await session.retireForReload()
        }
        documentChanged()
        try await rebuildNativeSettingsGraph(expectedGeneration: expectedGeneration)
        if pendingRestoreReload == expectedGeneration { pendingRestoreReload = nil }
        // A reload is the graph rebuild: the new graph is ready at once, and its document
        // establishes its own authority.
        nativeDocumentReady()
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
        guard nativeStorage != nil else { throw APIError.backendUnavailable }
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
            "ollama-status", "ollama-models", "provider-keys",
        ])
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
        installShellHost(for: model, hidden: shellHost?.isHidden ?? false)
        if restoredNativeGeneration == expectedGeneration { restoredNativeGeneration = nil }
    }

    /// The sections the user hid (`SIDEBAR_HIDDEN_SECTIONS` of the web sidebar), per Mac.
    private static let hiddenSectionsKey = "nativeSidebarHiddenSections"
    private static let sidebarCollapsedKey = "nativeSidebarCollapsed"

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

    /// The admin Bearer token of the shell's session. It lives only in the raw-state store's
    /// session values (`vision.adminToken`, never in settings.json); without one the backend's
    /// loopback allowlist applies.
    private func adminToken() async -> String? {
        guard isDocumentReady, let storage = nativeStorage else { return nil }
        return await storage.adminToken()
    }

    /// Home and Tax share the per-device dismissals. Only the known keys of
    /// `NativeShellStorage` are accessible.
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
            let value = try NativeShellStorage.chartLayoutValue(data)
            return try await chartLayoutStorage(writing: value, generation: generation) == value
        } catch { return false }
    }

    private func chartLayoutStorage(writing value: String?, generation: UUID) async throws -> String? {
        try requireNativeGeneration(generation)
        guard isDocumentReady, let storage = nativeStorage else { throw APIError.backendUnavailable }
        if let value {
            let stored = try await performStorageWrite(validate: { try requireNativeGeneration(generation) }) {
                try await storage.chartLayouts(writing: value)
            }
            try requireNativeGeneration(generation)
            return stored
        }
        let readSession = localStateSession
        try await readSession.checkRead()
        let stored = try await storage.chartLayouts(writing: nil)
        try requireNativeGeneration(generation)
        try await readSession.checkRead()
        return stored
    }

    /// Import checkpoints are session values and contain metadata only.
    private func portfolioSessionStorage(key: String, value: JSONValue? = nil, generation: UUID) async -> JSONValue? {
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        let result = await webStorage(key: key, value: value, session: true, generation: generation)
        guard (try? requireNativeGeneration(generation)) != nil else { return nil }
        return result
    }

    private func webStorage(key: String, value: JSONValue?, session: Bool, generation: UUID? = nil) async -> JSONValue?
    {
        guard isDocumentReady, let storage = nativeStorage else { return nil }
        guard value != nil else { return await storage.webStorage(key: key, value: nil, session: session) }
        return try? await performStorageWrite(validate: {
            if let generation { try requireNativeGeneration(generation) }
        }) {
            await storage.webStorage(key: key, value: value, session: session)
        }
    }

    /// The admin token card's access to the session's token.
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

    /// The trimmed token, or removal for a blank one. `false` when the shell is not ready or
    /// the write is refused; the storage is then unchanged as far as the card knows.
    private func writeAdminToken(_ token: String, generation: UUID) async -> Bool {
        guard (try? requireNativeGeneration(generation)) != nil, isDocumentReady, let storage = nativeStorage else {
            return false
        }
        do {
            try await performStorageWrite(validate: { try requireNativeGeneration(generation) }) {
                await storage.setAdminToken(token)
            }
        } catch { return false }
        return (try? requireNativeGeneration(generation)) != nil
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
        currentPageZoom = PageZoom.persisted(settings[PageZoom.settingsKey])
        self.strings = strings
        self.palette = palette
        launchModel = LaunchModel(appName: ShellController.appName, strings: strings, palette: palette)
        settingsTransport = transport
        settingsWriter = SettingsWriter(transport: transport)
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let maintenanceRelay = BackupMaintenanceRelay()
        backupMaintenance = maintenanceRelay
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
            maintenance: BackupMaintenanceHooks(
                willBeginSnapshot: { await maintenanceRelay.owner?.backupSnapshotWillBegin() },
                didEndSnapshot: { await maintenanceRelay.owner?.backupSnapshotDidEnd() }))
        super.init()
        backupMaintenance.owner = self
        installPreMigrationBackup()
        launchModel.onRetry = { [weak self] in self?.launch() }
        launchModel.onOpenLogs = { [weak self] in _ = try? self?.openLogs() }
    }

    /// `backupBeforeMigrations` in `main.ts` (ADR-242): the supervisor calls this after PostgreSQL is up
    /// and before a backend that will migrate an existing database starts. A failure aborts the launch
    /// with the localized `app.preMigrationBackupFailed` message.
    private func installPreMigrationBackup() {
        let service = backupService
        AppRuntime.preMigrationBackup.install { [weak self] pending, runtime in
            do {
                _ = try await service.backupBeforeMigrations(pending, runtime: runtime)
            } catch {
                let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
                AppRuntime.shellLogger.error(
                    "[pre-migration-backup] failed: \(message, privacy: .public)")
                let strings = await self?.strings
                throw NativeRuntimeError(
                    "PRE_MIGRATION_BACKUP_FAILED",
                    strings?.t("app.preMigrationBackupFailed", ["error": message], fallback: message) ?? message)
            }
        }
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

    /// Shows the launch state and resolves the runtime; the launch screen's Try again calls it again.
    func launch() {
        launchTask?.cancel()
        startTask?.cancel()
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
        case .ready(let url):
            appURL = url
            startShell(url: url)
        }
    }

    private func showLaunchView() {
        shellHost?.isHidden = true
        launchView?.isHidden = false
    }

    private func revealShell() {
        guard let host = shellHost, host.isHidden, nativeStorage != nil, case .ready = launchModel.state else {
            return
        }
        host.isHidden = false
        launchView?.isHidden = true
        if announceRunning {
            announceRunning = false
            post(strings.t("app.running", fallback: "Vision is running."))
        }
    }

    private func post(_ body: String) {
        let notifier = notifier
        Task { await notifier.post(body) }
    }

    /// Stops the debounced frame save and writes the current frame, then runs the
    /// quit-time backup when it is enabled; the shutdown task awaits both before the
    /// runtime stops, within the 45-second quit timeout.
    func prepareForQuit() async {
        stopHealthWatchdog()
        frameSaveTask?.cancel()
        await saveFrame()
        switch await runQuitBackup() {
        case .saved?: await notifier.post(strings.t("backup.done", fallback: "Backup saved."), askIfNeeded: false)
        case .failed?:
            await notifier.post(
                strings.t("backup.failed", fallback: "Backup failed. Check the backup folder."), askIfNeeded: false)
        case nil: break
        }
        // `await nativeMaintenanceDone`: a running backup or restore finishes before the
        // services stop; its end may have restarted the watchdog.
        await backupService.waitForMaintenance()
        stopHealthWatchdog()
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
    private func runQuitBackup() async -> QuitBackupOutcome? {
        guard await supervisor.backupRuntime() != nil else { return nil }
        let supervisor = self.supervisor
        let raw = await BackupSettings.rawForQuit(
            baseURL: appURL, transport: settingsTransport, fallback: { await supervisor.currentSettings() })
        return await backupService.runQuitBackup(rawSettings: raw)
    }

    /// The last of the quit sequence (`app.stopped`), awaited so the request reaches the
    /// notification center before the process exits. Quit never waits on a permission prompt.
    func announceStopped() async {
        await notifier.post(strings.t("app.stopped", fallback: "Vision has been stopped."), askIfNeeded: false)
    }

    // MARK: - Window

    private func createWindow() {
        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: WindowFrame.defaultSize),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.title = Self.appName
        // `titleBarStyle: "hiddenInset"`: the shell draws its own topbar under the traffic
        // lights and insets it.
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
        // Electron's `setVibrancy("under-window")`, shown only on the "enhanced" visual-effects tier.
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

    // MARK: - Native document

    /// Opens the raw-state store, builds the host and marks the graph's document ready. A store
    /// that exists but cannot be read shows the unavailable state; a missing file is the first
    /// launch and starts empty.
    private func startShell(url: URL) {
        startTask?.cancel()
        startTask = Task { [weak self] in
            guard let self else { return }
            do {
                if self.nativeStorage == nil { self.nativeStorage = try self.openNativeStorage() }
            } catch {
                self.logger.error("[shell] storage unavailable: \(String(describing: error), privacy: .public)")
                self.apply(.unavailable(self.strings.t("app.errorPageMessage")))
                return
            }
            guard !Task.isCancelled, self.appURL == url else { return }
            if self.shellHost == nil { self.installShellHost(for: self.shellModel, hidden: true) }
            self.shellHost?.isHidden = true
            self.announceRunning = true
            self.nativeDocumentReady()
            self.logger.log("[shell] document ready")
            self.startHealthWatchdog(url)
        }
    }

    private func openNativeStorage() throws -> NativeShellStorage {
        let store = try NativeRawStateStore(persistenceURL: URL(fileURLWithPath: supervisor.rawStatePath))
        return NativeShellStorage(store: store)
    }

    /// Replaces the SwiftUI shell with one for `model`, below the launch view.
    private func installShellHost(for model: NativeShellModel, hidden: Bool) {
        shellHost?.removeFromSuperview()
        let host = NSHostingView(rootView: ShellRootView(model: model))
        host.sizingOptions = []
        // The window keeps its own title and has no toolbar; SwiftUI must not add either.
        host.sceneBridgingOptions = []
        host.frame = container?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        host.isHidden = hidden
        container?.addSubview(host, positioned: .below, relativeTo: launchView)
        shellHost = host
    }

    /// The previous document, if any, no longer holds authority: its startup task and its
    /// storage access stop at their next check.
    private func documentChanged() {
        documentGeneration = UUID()
        isDocumentReady = false
    }

    /// A fresh document token for this graph, the display state, then the shared startup
    /// (settings, onboarding, StartupRedirect).
    private func nativeDocumentReady() {
        documentChanged()
        shellModel.setNativeDocumentState(.ready)
        startNativeDocument()
    }

    private func startNativeDocument() {
        isDocumentReady = true
        let document = documentGeneration
        let documentSettingsGeneration = nativeSettingsGeneration
        Task { [weak self] in
            guard let self, document == self.documentGeneration,
                documentSettingsGeneration == self.nativeSettingsGeneration, let storage = self.nativeStorage
            else { return }
            // A restore applies its backup state and acknowledges onboarding before its own
            // reload, and a reload owns its full drain; neither starts the document here.
            guard !self.restoreFenceEntered, self.pendingRestoreReload != documentSettingsGeneration,
                self.manualReloadTask == nil, self.nativeSettingsRebuildTask == nil
            else { return }
            // A restored graph that was retired without its reload is rebuilt first.
            if self.restoredNativeGeneration == documentSettingsGeneration {
                do { try await self.rebuildNativeSettingsGraph(expectedGeneration: documentSettingsGeneration) } catch {
                    return
                }
                self.shellModel.setNativeDocumentState(.ready)
            }
            let generation = self.nativeSettingsGeneration
            let model = self.shellModel
            let isCurrentStartup = {
                document == self.documentGeneration
                    && generation == self.nativeSettingsGeneration && model === self.shellModel
                    && !self.restoreFenceEntered && self.pendingRestoreReload == nil
                    && self.restoredNativeGeneration == nil && self.manualReloadTask == nil
                    && self.nativeSettingsRebuildTask == nil
            }
            guard isCurrentStartup() else { return }
            model.isReloadingGraph = false
            await self.loadNativeSettingsLegacyTheme(document: document, storage: storage)
            guard isCurrentStartup() else { return }
            await model.nativeSettings?.load()
            guard isCurrentStartup() else { return }
            await model.onboarding?.load()
            guard isCurrentStartup() else { return }
            self.resolveNativeSettingsAppearance()
            self.startNativeSettingsAppearanceWatch()
            // The shell owns StartupRedirect: capture its two raw values before tracking
            // overwrites them, then resolve once from the mirror or the loaded settings.
            let mirror = try? await self.nativeLocalValue(.startupSection, generation: generation)
            let lastRoute = try? await self.nativeLocalValue(.lastRoute, generation: generation)
            guard isCurrentStartup() else { return }
            var startup = NativeNavigationStartup(
                context: self.nativeStartupResolved ? .documentReload : .newSession,
                mirroredStartupSection: mirror ?? nil, lastRoute: lastRoute ?? nil)
            self.nativeStartupResolved = true
            self.applyNativeStartup(&startup, model: model)
            model.reloadSettings()
            // Queued cold and menu intents wait for document, settings and onboarding.
            model.nativeIntentReadinessDidChange()
            await model.settingsSettled()
            guard isCurrentStartup() else { return }
            self.applyNativeStartup(&startup, model: model)
            model.nativeIntentReadinessDidChange()
            self.persistNativeNavigation(model: model, generation: generation)
            self.trackNativeNavigation(model: model, generation: generation)
        }
        revealShell()
    }

    func showWindow() {
        guard let window else { return }
        if window.isMiniaturized { window.deminiaturize(nil) }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // macOS convention kept from Electron: closing hides the window, so the shell keeps
        // its route and a dock click shows it again at once.
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

    func windowDidExitFullScreen(_ notification: Notification) {
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

    // MARK: - Native navigation startup (ADR-211)

    private func applyNativeStartup(_ startup: inout NativeNavigationStartup, model: NativeShellModel) {
        guard !startup.hasResolved else { return }
        let current = model.nativeNavigationLocation.raw
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
    private func persistNativeNavigation(model: NativeShellModel, generation: UUID) {
        let route = model.nativeNavigationLocation.raw
        let section = model.settingsLoaded ? model.settings.startupSection : nil
        Task { [weak self] in
            try? await self?.writeNativeLocalValue(route, key: .lastRoute, generation: generation)
            if let section {
                try? await self?.writeNativeLocalValue(section, key: .startupSection, generation: generation)
            }
        }
    }

    private func trackNativeNavigation(model: NativeShellModel, generation: UUID) {
        withObservationTracking {
            _ = model.nativeNavigationLocation.raw
            _ = model.settings.startupSection
        } onChange: { [weak self, weak model] in
            Task { @MainActor in
                guard let self, let model, generation == self.nativeSettingsGeneration else { return }
                self.persistNativeNavigation(model: model, generation: generation)
                self.trackNativeNavigation(model: model, generation: generation)
            }
        }
    }

    // MARK: - CSV handoff

    /// Finder "Open With" and dock drops of a CSV. The native import card gets the file
    /// (pre-filled, not started) once the document, settings and onboarding are ready, and the
    /// shell moves to `/import`, so a cold launch does not lose it.
    func openFiles(_ urls: [URL]) {
        for url in urls {
            Task { [weak self] in
                guard let data = await ShellController.readCSV(url), let self else { return }
                self.showWindow()
                _ = self.shellModel.openImportFile(
                    ImportFile(name: url.lastPathComponent, data: data, mimeType: "text/csv"))
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
            title: "Main Menu",
            entries: ApplicationMenu.build(appName: Self.appName, strings: strings))
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
            !shellModel.isReloadingGraph, !shellModel.isPresentingNativeOverlay, isDocumentReady
        else { return false }
        switch shellModel.printDisposition {
        case .nativePage: return capturePagePrintSnapshot() != nil
        case .unavailable: return false
        }
    }

    private func printCurrentPage() {
        guard canPrintCurrentPage else { return }
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

    /// Fences the graph's input while it is torn down for a reload or a restore: SwiftUI controls
    /// are disabled by the model, and any focused AppKit control gives up its keyboard focus.
    private func holdNativeGraphInput(_ model: NativeShellModel) {
        model.isReloadingGraph = true
        window?.makeFirstResponder(nil)
    }

    @discardableResult
    private func reloadCurrentGraph() -> Task<Bool, Never>? {
        guard appURL != nil, nativeStorage != nil, manualReloadTask == nil,
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
                self.logger.error("native reload failed: \(error.localizedDescription, privacy: .public)")
                return false
            }
        }
        return manualReloadTask
    }

    func run(_ command: MenuCommand) {
        guard !shellModel.isReloadingGraph else { return }
        switch command {
        case .print:
            printCurrentPage()
        case .action(let action):
            // Native owners take every menu action; navigation goes through the shell, so a
            // native screen's unsaved-changes guard can hold it.
            if !shellModel.acceptNativeMenuAction(action) {
                logger.warning("[shell] menu action \(action.action, privacy: .public) has no native owner")
            }
        case .openExternal(let link):
            if let url = ShellLinks.trustedExternalURL(URL(string: link)) { NSWorkspace.shared.open(url) }
        case .about:
            showAboutPanel()
        case .reload:
            if appURL != nil { reloadCurrentGraph() } else { launch() }
        case .resetZoom:
            applyPageZoom(1)
        case .zoomIn:
            applyPageZoom(PageZoom.zoomedIn(from: shellModel.pageZoom))
        case .zoomOut:
            applyPageZoom(PageZoom.zoomedOut(from: shellModel.pageZoom))
        default:
            // Role items use AppKit's standard actions (MenuController).
            break
        }
    }

    /// `startHealthWatchdog`: a lost backend is announced once and its recovery clears the
    /// notice.
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
                    self.backendNoticeID = self.shellModel.notices.publish(
                        .init(id: 0, kind: .warning, key: "app.backendLost"), source: self.backendNoticeSource,
                        lifetime: 30, replacementKey: "backend-health")
                case .restored:
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

    /// `withBackupSnapshot` in main.ts, before the capture: the watchdog pauses, because the
    /// backend stops on purpose.
    fileprivate func backupSnapshotWillBegin() {
        stopHealthWatchdog()
    }

    /// After the capture, also a failed one: the watchdog restarts.
    fileprivate func backupSnapshotDidEnd() async {
        guard let url = appURL else { return }
        startHealthWatchdog(url)
    }

    /// Applies a zoom step to the native screens and keeps it for the next launch.
    private func applyPageZoom(_ zoom: Double) {
        currentPageZoom = zoom
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
        effectView?.appearance = Self.vibrancyAppearance(palette)
        launchModel.palette = palette
    }

    /// The vibrancy follows the shell theme, not the macOS appearance.
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
    }

    func setDockBadge(_ count: Int) {
        NSApp.dockTile.badgeLabel = DockBadge.label(for: count)
    }

    /// `app:set-language`: a request for the active language still supersedes an older one
    /// that is loading.
    private func setLanguage(_ language: NativeLanguage) async {
        languageRequest += 1
        let request = languageRequest
        if strings.language == language { return }
        let directory = Self.localeDirectory
        let loaded = await Task.detached { ShellStrings.load(language: language, directory: directory) }.value
        guard request == languageRequest else { return }
        strings = loaded
        launchModel.strings = loaded
        shellModel.strings = CatalogStrings(language: language)
        shellModel.onboarding?.strings = shellModel.strings
        do {
            try await supervisor.updateSettings { $0["nativeLanguage"] = .string(language.rawValue) }
        } catch {
            logger.warning("nativeLanguage save failed (non-fatal): \(error.localizedDescription, privacy: .public)")
        }
        guard request == languageRequest else { return }
        installMenus()
    }

    /// The window's material shows through only on the "enhanced" visual-effects tier.
    private func setVibrancy(_ enabled: Bool) {
        effectView?.isHidden = !enabled
    }

    private func accentColor() -> String? {
        guard let color = NSColor.controlAccentColor.usingColorSpace(.sRGB) else { return nil }
        return AccentColor.hex(
            red: Double(color.redComponent), green: Double(color.greenComponent), blue: Double(color.blueComponent),
            alpha: Double(color.alphaComponent))
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
        // `backup:is-encrypted`: only a path the restore picker returned.
        guard let picked = restorePathAllowList.pickedPath(path) else { return false }
        return await backupService.isEncrypted(picked)
    }

    /// The restore: the localized confirmation, then the restore, which stops and restarts the
    /// backend itself. Native Settings owns the reload that follows.
    private func restoreNativeBackup(
        _ path: String, passphrase: String?, onboardingRestore: Bool
    ) async -> JSONValue {
        guard !restoreFenceEntered, pendingRestoreReload == nil, !shellModel.isReloadingGraph else {
            return .object(["success": .bool(false), "error": .string("A restore is already in progress")])
        }
        // `ALLOWED_RESTORE_PATHS` and `hasAllowedRestoreExt`: only a file the restore picker returned,
        // with a backup extension, is restored.
        guard let picked = restorePathAllowList.pickedPath(path) else {
            return .object([
                "success": .bool(false), "error": .string("Restore path was not selected via the file picker"),
            ])
        }
        guard RestorePathAllowList.hasAllowedExtension(picked) else {
            return .object(["success": .bool(false), "error": .string("Unsupported backup file extension")])
        }
        let operation = UUID()
        let fileName = (picked as NSString).lastPathComponent
        let result = await backupService.restore(
            path: picked, passphrase: passphrase,
            confirm: { [weak self] in
                await self?.confirmAndSuspendForRestore(fileName: fileName, operation: operation) ?? false
            })
        if restoreFenceEntered, restoreFenceOwner == operation {
            if result["success"] == .bool(true) {
                restoredNativeGeneration = nativeSettingsGeneration
                pendingRestoreReload = nativeSettingsGeneration
                restoredFrontendSession = NativeLocalStateSession()
                restoredCompletionDataSession = NativeDataSession()
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
            }
            restoreFenceEntered = false
            restoreFenceOwner = nil
        }
        return result
    }

    private func confirmAndSuspendForRestore(fileName: String, operation: UUID) async -> Bool {
        guard !restoreFenceEntered, pendingRestoreReload == nil, !shellModel.isReloadingGraph,
            await confirmRestore(fileName: fileName), !restoreFenceEntered, pendingRestoreReload == nil,
            !shellModel.isReloadingGraph
        else { return false }
        restoreFenceEntered = true
        restoreFenceOwner = operation
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
            RestoreConfirmation(
                title: strings.t("settings.restore.title", fallback: "Restore Backup"),
                message: strings.t(
                    "settings.restore.warning",
                    fallback: "This will permanently replace all current data and cannot be undone."),
                detail: fileName,
                confirmLabel: strings.t("settings.restore.runNow", fallback: "Restore"),
                cancelLabel: strings.t("settings.restore.cancelButton", fallback: "Cancel")))
    }

    /// A warning alert, as a sheet when the window is visible; Cancel is the default
    /// button (`defaultId: 1, cancelId: 1`).
    private func confirm(_ confirmation: RestoreConfirmation) async -> Bool {
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

    func openLogs() throws -> String {
        let path = supervisor.logsDirectory
        try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
        guard NSWorkspace.shared.open(URL(fileURLWithPath: path, isDirectory: true)) else {
            throw CocoaError(.fileNoSuchFile, userInfo: [NSFilePathErrorKey: path])
        }
        return path
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

/// A weak path from the backup service's maintenance hooks to the controller, which does
/// not exist yet when the service is created in `ShellController.init`.
@MainActor
private final class BackupMaintenanceRelay {
    weak var owner: ShellController?
}

/// A warning dialog with Cancel as the default button (`defaultId: 1, cancelId: 1`).
private struct RestoreConfirmation {
    var title: String
    var message: String
    var detail: String?
    var confirmLabel: String
    var cancelLabel: String
}
