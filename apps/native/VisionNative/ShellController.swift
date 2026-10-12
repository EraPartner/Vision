import AppKit
import OSLog
import SwiftUI
import VisionNativeCore
import WebKit

/// Owns the window, menus, dock and web shell, and answers the page's bridge calls
/// (the main-process side of packaging/electron/main.ts for phase 1c).
@MainActor
final class ShellController: NSObject, NSWindowDelegate, BridgeHost {
    static let appName = "Vision Native"
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
    private(set) var window: NSWindow?
    private var container: NSView?
    private var effectView: NSVisualEffectView?
    private var launchView: NSHostingView<LaunchStateView>?
    private var webShell: WebShell?
    /// The backend base URL the web view may show; `nil` until the runtime is ready.
    private(set) var appURL: URL?
    private var queue = RendererMessageQueue()
    private var launchTask: Task<Void, Never>?
    private var revealTask: Task<Void, Never>?
    private var frameSaveTask: Task<Void, Never>?
    private var languageRequest = 0
    private var accentObserver: NSObjectProtocol?

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
            shell.webView.isHidden = true
            queue.documentChanged()
            shell.load(url)
        }
    }

    private func showLaunchView() {
        revealTask?.cancel()
        webShell?.webView.isHidden = true
        launchView?.isHidden = false
    }

    private func revealWebView() {
        revealTask?.cancel()
        guard let webView = webShell?.webView, webView.isHidden, case .ready = launchModel.state else { return }
        webView.isHidden = false
        launchView?.isHidden = true
        window?.makeFirstResponder(webView)
    }

    /// Stops the debounced frame save and writes the current frame before the runtime stops.
    func prepareForQuit() {
        frameSaveTask?.cancel()
        Task { await saveFrame() }
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

    private func makeWebShell() -> WebShell {
        let shell = WebShell(controller: self)
        let webView = shell.webView
        webView.frame = container?.bounds ?? .zero
        webView.autoresizingMask = [.width, .height]
        webView.isHidden = true
        webView.underPageBackgroundColor = .hsl(palette.base)
        container?.addSubview(webView, positioned: .below, relativeTo: launchView)
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

    func documentDidStart() {
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

    func openFiles(_ urls: [URL]) {
        for url in urls {
            Task { [weak self] in
                guard let payload = await ShellController.readCSV(url) else { return }
                self?.sendToApp(.csvOpened, payload)
            }
        }
    }

    private nonisolated static func readCSV(_ url: URL) async -> JSONValue? {
        let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
        guard
            CSVHandoff.accepts(
                path: url.path, isRegularFile: values?.isRegularFile == true, size: values?.fileSize),
            let data = try? Data(contentsOf: url)
        else {
            return nil
        }
        return CSVHandoff.payload(name: url.lastPathComponent, data: data)
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
        case .renderer(let action):
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
        launchModel.palette = palette
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

    func titlebarDoubleClicked() {
        guard let window else { return }
        switch TitlebarDoubleClickAction.from(userDefault: UserDefaults.standard.string(forKey: "AppleActionOnDoubleClick")) {
        case .zoom: window.performZoom(nil)
        case .minimize: window.performMiniaturize(nil)
        case .none: break
        }
    }
}

extension NSColor {
    static func hsl(_ color: HSLColor, alpha: Double = 1) -> NSColor {
        let rgb = color.rgb
        return NSColor(srgbRed: rgb.red, green: rgb.green, blue: rgb.blue, alpha: alpha)
    }
}
