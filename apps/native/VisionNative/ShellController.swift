import AppKit
import OSLog
import os
import SwiftUI
import UniformTypeIdentifiers
import VisionNativeCore
import VisionNativeUI
import WebKit

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
    private let settingsWriter: SettingsWriter
    private let backupService: BackupService
    /// The six `electronAudit` channels, the closure timer and the audit notices.
    private lazy var auditChannels = makeAuditChannels()
    /// The typed API client of native screens (`client.ts`).
    private lazy var apiClient = makeAPIClient()
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
    private var queue = RendererMessageQueue()
    private var launchTask: Task<Void, Never>?
    private var pageLoadTask: Task<Void, Never>?
    private var revealTask: Task<Void, Never>?
    private var frameSaveTask: Task<Void, Never>?
    private var languageRequest = 0
    private var accentObserver: NSObjectProtocol?

    private func makeAuditChannels() -> AuditChannels {
        AuditChannels(
            runtimeProvider: { await AppRuntime.supervisor.auditRuntime() }, shell: self,
            log: { message in AppRuntime.shellLogger.warning("\(message, privacy: .public)") })
    }

    private func makeAPIClient() -> APIClient {
        APIClient(
            baseURL: { [weak self] in await self?.appURL },
            adminToken: { [weak self] in await self?.adminToken() })
    }

    private func makeShellModel() -> NativeShellModel {
        let client = apiClient
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
        return NativeShellModel(
            strings: CatalogStrings(language: strings.language),
            theme: ThemeSelection.resolve(
                splashTheme: LaunchAppearance.theme(fromSettings: initialSettings), systemIsDark: systemIsDark),
            exchangeRates: rates,
            admin: AdminScreens.make(
                service: client, database: client, token: makeAdminTokenAccess(), audit: auditChannels),
            planned: PlannedPaymentsModel(service: client, editing: client, pickers: client, rates: rates),
            imports: imports,
            transactions: transactions,
            // `/accounts` converts its subtotals with the same shared rates cache.
            accounts: AccountsModel(service: client, rates: rates),
            categories: CategoriesModel(service: client),
            recipients: RecipientsModel(service: client),
            home: HomeModel(service: client,
                readLocal: { [weak self] key in await self?.homeLocalStorage(key: key) },
                writeLocal: { [weak self] key, value in _ = await self?.homeLocalStorage(key: key, value: value) }),
            statistics: StatisticsScreens(client: client),
            hiddenSections: Self.loadHiddenSections(),
            loadSettings: { try await client.appSettings() },
            saveHiddenSections: { Self.saveHiddenSections($0) },
            onNavigate: { [weak self] action in
                self?.sendToApp(.menuAction, BridgeDispatcher.menuActionPayload(action))
            },
            onSidebarVisibilityChange: { [weak self] visible in
                self?.deliver(.menuAction, BridgeDispatcher.menuActionPayload(.nativeSidebar(visible: visible)))
            })
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

    /// Home shares the web app's per-device dismissals. Only these two known keys are
    /// accessible, and every argument goes through WebKit's argument binding.
    private func homeLocalStorage(key: String, value: JSONValue? = nil) async -> JSONValue? {
        guard ["vision.home.dismissedAccountInactivity", "dismissed_upcoming_planned_payments"].contains(key),
              queue.isReady, let webView = webShell?.webView else { return nil }
        let encoded = value.flatMap { try? String(data: $0.serialized(), encoding: .utf8) }
        return await withCheckedContinuation { (continuation: CheckedContinuation<JSONValue?, Never>) in
            let pending = OSAllocatedUnfairLock<CheckedContinuation<JSONValue?, Never>?>(initialState: continuation)
            let resume: @Sendable (JSONValue?) -> Void = { answer in
                let waiting = pending.withLock { state -> CheckedContinuation<JSONValue?, Never>? in
                    defer { state = nil }; return state
                }
                waiting?.resume(returning: answer)
            }
            let timeout = Task {
                try? await Task.sleep(for: Self.adminTokenTimeout)
                resume(nil)
            }
            webView.callAsyncJavaScript(
                "try { if (writing) localStorage.setItem(key, value); return localStorage.getItem(key) || 'null'; } catch { return 'null'; }",
                arguments: ["key": key, "value": encoded ?? "null", "writing": value != nil], in: nil, in: .page
            ) { result in
                let answer = ((try? result.get()) as? String).flatMap { try? JSONValue.parse(Data($0.utf8)) }
                resume(answer); timeout.cancel()
            }
        }
    }

    private static let adminTokenScript = AdminTokenScript.read

    /// The admin token card's access to the page's `sessionStorage`.
    private func makeAdminTokenAccess() -> AdminTokenAccess {
        AdminTokenAccess(
            read: { [weak self] in await self?.adminToken() },
            write: { [weak self] token in await self?.writeAdminToken(token) ?? false })
    }

    /// `setAdminToken(token)` in the page: the trimmed token, or removal for a blank one. The
    /// token goes in as a script argument, never as script text. `false` when the page is not
    /// ready, the script fails or the page does not answer within `adminTokenTimeout`; the
    /// storage is then unchanged as far as the card knows.
    private func writeAdminToken(_ token: String) async -> Bool {
        guard queue.isReady, let webView = webShell?.webView else { return false }
        return await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
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
                resume(((try? result.get()) as? String) == "ok")
                timeout.cancel()
            }
        }
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
            showLaunchView()
        case .ready(let url):
            appURL = url
            let shell = webShell ?? makeWebShell()
            shellHost?.isHidden = true
            queue.documentChanged()
            // `loadApplicationPage`: the audit session is established before the page
            // loads; the closure timer then runs while the page is up.
            pageLoadTask?.cancel()
            pageLoadTask = Task { [weak self] in
                await self?.auditChannels.applicationWillLoad()
                guard !Task.isCancelled, let self, self.appURL == url else { return }
                shell.load(url)
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
        let shell = WebShell(controller: self)
        let webView = shell.webView
        webView.underPageBackgroundColor = .hsl(palette.base)
        let host = NSHostingView(
            rootView: ShellRootView(model: shellModel) { hidden in WebViewHost(webView: webView, hidden: hidden) })
        host.sizingOptions = []
        // The window keeps its own title and has no toolbar; SwiftUI must not add either.
        host.sceneBridgingOptions = []
        host.frame = container?.bounds ?? .zero
        host.autoresizingMask = [.width, .height]
        host.isHidden = true
        container?.addSubview(host, positioned: .below, relativeTo: launchView)
        shellHost = host
        webShell = shell
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
    }

    func windowDidMove(_ notification: Notification) {
        scheduleFrameSave()
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

    func documentDidCommit() {
        queue.documentChanged()
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
        webShell?.webView.evaluateJavaScript(BridgeDispatcher.eventScript(event, payload: payload), completionHandler: nil)
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

    func run(_ command: MenuCommand) {
        switch command {
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
            if let webView = webShell?.webView, appURL != nil { webView.reload() } else { launch() }
        case .resetZoom:
            webShell?.webView.pageZoom = 1
        case .zoomIn:
            if let webView = webShell?.webView { webView.pageZoom = PageZoom.zoomedIn(from: Double(webView.pageZoom)) }
        case .zoomOut:
            if let webView = webShell?.webView { webView.pageZoom = PageZoom.zoomedOut(from: Double(webView.pageZoom)) }
        default:
            // Role items use AppKit's standard actions (MenuController).
            break
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
        accentObserver = DistributedNotificationCenter.default().addObserver(
            forName: NSNotification.Name("AppleColorPreferencesChangedNotification"), object: nil, queue: .main
        ) { [weak self] _ in
            Task { @MainActor in self?.accentColorDidChange() }
        }
    }

    private func accentColorDidChange() {
        guard queue.isReady else { return }
        deliver(.accentColorChanged, accentColor().map(JSONValue.string) ?? .null)
    }

    // MARK: - BridgeHost

    func rendererDidFail(_ failure: RendererFailure) {
        let location = failure.line > 0 ? "\(failure.source):\(failure.line)" : failure.source
        logger.error("[renderer] \(failure.kind, privacy: .public) (\(failure.name, privacy: .public)) at \(location, privacy: .public)")
    }

    func rendererDidBecomeReady() {
        for message in queue.markReady() { evaluate(message.event, message.payload) }
        deliver(.menuAction, BridgeDispatcher.menuActionPayload(.nativeSidebar(visible: shellModel.isSidebarVisible)))
        shellModel.reloadSettings()
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
        do {
            try await supervisor.updateSettings { $0["nativeLanguage"] = .string(language.rawValue) }
        } catch {
            logger.warning("nativeLanguage save failed (non-fatal): \(error.localizedDescription, privacy: .public)")
        }
        guard request == languageRequest else { return .superseded }
        installMenus()
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
        return await withCheckedContinuation { (continuation: CheckedContinuation<NSApplication.ModalResponse, Never>) in
            panel.beginSheetModal(for: window) { response in continuation.resume(returning: response) }
        }
    }

    func isBackupEncrypted(_ path: String) async -> Bool {
        await backupService.isEncrypted(path)
    }

    /// `backup:restore`: the localized confirmation, then the restore, which stops and
    /// restarts the backend itself.
    func restoreBackup(_ path: String, passphrase: String?) async -> JSONValue {
        let fileName = (path as NSString).lastPathComponent
        // `stopHealthWatchdog` stops the closure timer for the restore;
        // `startHealthWatchdog` starts it again.
        auditChannels.stopClosureTimer()
        let result = await backupService.restore(
            path: path, passphrase: passphrase,
            confirm: { [weak self] in await self?.confirmRestore(fileName: fileName) ?? false },
            confirmAuditRecovery: { [weak self] status in
                await self?.confirmAuditRecovery(fileName: fileName, auditStatus: status) ?? false
            })
        if result["auditStatus"]?.stringValue == "unavailable" {
            auditChannels.report("unavailable")
        }
        await auditChannels.startClosureTimer()
        return result
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

    func titlebarDoubleClicked() {
        guard let window else { return }
        switch TitlebarDoubleClickAction.from(userDefault: UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")) {
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
