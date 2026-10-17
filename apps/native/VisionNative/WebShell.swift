import AppKit
import OSLog
import SwiftUI
import VisionNativeCore
import WebKit

/// The `WKWebView` that hosts the React frontend served by the backend (phase 1 of ADR-204).
final class ShellWebView: WKWebView {
    /// The last left mouse-down, which `NSWindow.performDrag(with:)` needs for the topbar
    /// drag region.
    private(set) var lastMouseDown: NSEvent?

    override func mouseDown(with event: NSEvent) {
        lastMouseDown = event
        super.mouseDown(with: event)
    }

    /// A transparent page background lets the vibrancy material show through. WebKit has no
    /// public API for it; `drawsBackground` is the key-value setting other WebKit shells use.
    func setDrawsPageBackground(_ draws: Bool) {
        let setters = ["_setDrawsBackground:", "setDrawsBackground:"].map(NSSelectorFromString)
        guard setters.contains(where: { responds(to: $0) }) else { return }
        setValue(draws, forKey: "drawsBackground")
    }
}

/// The web view, its navigation, new-window, download and file-picker policy, and the bridge.
@MainActor
final class WebShell: NSObject {
    let webView: ShellWebView
    private(set) weak var controller: ShellController?
    private let logger = AppRuntime.shellLogger
    private var crashPolicy = CrashReloadPolicy()
    /// Downloads that replace an existing file, by download, until they finish or fail.
    private var replacements: [ObjectIdentifier: (temporary: URL, destination: URL)] = [:]
    /// ADR-207: set only for a selected helper document, which gets the fixed helper
    /// handler instead of the generic `electronAPI` bridge.
    let helperSource: NativeHelperDocumentSession.Source?
    /// The WKNavigation object of the current helper load and its opaque native identity.
    private var helperNavigation: (navigation: WKNavigation, id: UUID)?

    init(controller: ShellController, helperSource: NativeHelperDocumentSession.Source? = nil) {
        self.helperSource = helperSource
        let contentController = WKUserContentController()
        contentController.addUserScript(
            WKUserScript(
                source: helperSource == nil ? BridgeScript.source : NativeHelperDocumentBridge.documentStartScript,
                injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.websiteDataStore = .default()
        webView = ShellWebView(frame: .zero, configuration: configuration)
        self.controller = controller
        super.init()
        if helperSource == nil {
            contentController.addScriptMessageHandler(
                BridgeMessageHandler(shell: self), contentWorld: .page, name: BridgeContract.messageHandlerName)
        } else {
            contentController.addScriptMessageHandler(
                HelperDocumentMessageHandler(shell: self), contentWorld: .page,
                name: NativeHelperDocumentBridge.messageHandlerName)
        }
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
            // Enables the Safari Web Inspector (developer extras) in Debug builds only.
            webView.isInspectable = true
        #endif
    }

    func load(_ url: URL) {
        crashPolicy.reset()
        track(webView.load(URLRequest(url: url)))
    }

    /// Reloads the current document; a helper reload is a new navigation authority.
    func reload() {
        track(webView.reload())
    }

    private func track(_ navigation: WKNavigation?) {
        guard helperSource != nil else { return }
        let id = UUID()
        helperNavigation = navigation.map { ($0, id) }
        controller?.helperDocumentWillNavigate(id)
    }

    /// Built only from this web view, its main frame and the tracked WKNavigation object;
    /// nothing in it is decoded from the page.
    func helperObservation(
        for navigation: WKNavigation?, isMainFrame: Bool = true, securityOrigin: URL? = nil
    ) -> NativeHelperDocumentSession.Observation? {
        guard helperSource != nil, let current = helperNavigation, let url = webView.url else { return nil }
        if let navigation, navigation !== current.navigation { return nil }
        guard let origin = securityOrigin ?? Self.origin(of: url) else { return nil }
        return .init(
            navigationID: current.id, documentURL: url, websiteDataStoreIdentifier: "default",
            isMainFrame: isMainFrame, securityOrigin: origin)
    }

    static func origin(of url: URL) -> URL? {
        guard let scheme = url.scheme, let host = url.host(percentEncoded: false) else { return nil }
        var parts = URLComponents()
        parts.scheme = scheme
        parts.host = host
        parts.port = url.port
        return parts.url
    }

    private func describe(_ url: URL?) -> String {
        // Scheme and host only: paths and queries can carry financial data.
        guard let url else { return "no URL" }
        return "\(url.scheme ?? "?"):\(url.host.map { "//\($0)" } ?? "")"
    }

    fileprivate func actionPolicy(_ decision: NavigationDecision, _ url: URL?) -> WKNavigationActionPolicy {
        switch decision {
        case .allow:
            return .allow
        case .download:
            return .download
        case .openExternally(let external):
            NSWorkspace.shared.open(external)
            return .cancel
        case .cancel(let reason):
            logger.warning("Blocked \(reason, privacy: .public): \(self.describe(url), privacy: .public)")
            return .cancel
        }
    }

    /// Presents a panel as a sheet on the window, or as a modal without one.
    fileprivate func run(_ panel: NSSavePanel) async -> NSApplication.ModalResponse {
        guard let window = webView.window else { return panel.runModal() }
        return await withCheckedContinuation { continuation in
            panel.beginSheetModal(for: window) { response in continuation.resume(returning: response) }
        }
    }
}

extension WebShell: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async
        -> WKNavigationActionPolicy
    {
        guard let appURL = controller?.appURL else { return .cancel }
        let url = navigationAction.request.url
        // A nil target frame is a new-window request; WebKit then asks the UI delegate.
        let decision = NavigationPolicy.decideNavigation(
            url: url, isMainFrame: navigationAction.targetFrame?.isMainFrame ?? true,
            shouldPerformDownload: navigationAction.shouldPerformDownload, appURL: appURL)
        return actionPolicy(decision, url)
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse) async
        -> WKNavigationResponsePolicy
    {
        guard let appURL = controller?.appURL else { return .cancel }
        let response = navigationResponse.response
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        switch NavigationPolicy.decideResponse(
            url: response.url, isMainFrame: navigationResponse.isForMainFrame,
            canShowMIMEType: navigationResponse.canShowMIMEType, contentDisposition: disposition, appURL: appURL)
        {
        case .allow:
            return .allow
        case .download:
            return .download
        case .openExternally, .cancel:
            logger.warning("Blocked a response from \(self.describe(response.url), privacy: .public)")
            return .cancel
        }
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    /// A new document replaced the old one. A provisional load that becomes a download never
    /// commits, so the page that is still showing keeps its readiness and queued events.
    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        controller?.documentDidCommit()
        if helperSource != nil { controller?.helperDocumentDidCommit(helperObservation(for: navigation)) }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        controller?.documentDidFinish()
        if helperSource != nil { controller?.helperDocumentDidFinish(helperObservation(for: navigation)) }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        let nsError = error as NSError
        // A superseded load (-999) or one the policy turned into a download (102) is not a failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        controller?.documentDidFail(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Electron logs `render-process-gone`; WebKit leaves a blank view, so reload as well,
        // but not in a loop.
        guard crashPolicy.shouldReload(at: ProcessInfo.processInfo.systemUptime) else {
            logger.error("[renderer] web content process terminated repeatedly; showing the error page")
            controller?.webContentKeepsTerminating()
            return
        }
        logger.error("[renderer] web content process terminated; reloading")
        reload()
    }
}

extension WebShell: WKUIDelegate {
    func webView(
        _ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        let url = navigationAction.request.url
        _ = actionPolicy(NavigationPolicy.decideNewWindow(url: url), url)
        return nil
    }

    /// `<input type="file">` (CSV import, attachments); WebKit shows nothing without this.
    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo
    ) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        return await run(panel) == .OK ? panel.urls : nil
    }

    /// Electron's permission handler grants no camera or microphone.
    func webView(
        _ webView: WKWebView, decideMediaCapturePermissionsFor origin: WKSecurityOrigin,
        initiatedBy frame: WKFrameInfo, type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        .deny
    }
}

extension WebShell: WKDownloadDelegate {
    /// Electron's default download behaviour: a save panel in Downloads with the suggested name.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async
        -> URL?
    {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = NavigationPolicy.downloadFilename(suggestedFilename)
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard await run(panel) == .OK, let url = panel.url else { return nil }
        // The panel already confirmed the replacement, but WKDownload refuses an existing file:
        // download next to it and replace it only once the download finished.
        switch DownloadDestination.plan(for: url, id: UUID()) {
        case .direct(let destination):
            return destination
        case .replace(let temporary, let destination):
            replacements[ObjectIdentifier(download)] = (temporary, destination)
            return temporary
        case .refuse(let reason):
            logger.error("download refused: \(reason, privacy: .public)")
            return nil
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let replacement = replacements.removeValue(forKey: ObjectIdentifier(download)) else {
            logger.log("download finished")
            return
        }
        do {
            try DownloadDestination.finish(temporary: replacement.temporary, destination: replacement.destination)
            logger.log("download finished")
        } catch {
            logger.error("download: could not replace the existing file: \(error.localizedDescription, privacy: .public)")
        }
    }

    func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
        if let replacement = replacements.removeValue(forKey: ObjectIdentifier(download)) {
            DownloadDestination.discard(temporary: replacement.temporary)
        }
        logger.error("download failed: \(error.localizedDescription, privacy: .public)")
    }
}

/// Answers `window.webkit.messageHandlers.visionNative.postMessage(...)`; the promise
/// resolves with the reply's JSON text or rejects with its error message.
@MainActor
final class BridgeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var shell: WebShell?

    init(shell: WebShell) {
        self.shell = shell
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage)
        async -> (Any?, String?)
    {
        guard let controller = shell?.controller else { return (nil, BridgeDispatcher.unauthorizedSenderMessage) }
        let origin = message.frameInfo.securityOrigin
        let sender = BridgeSender(
            isMainFrame: message.frameInfo.isMainFrame,
            origin: BridgeOrigin(scheme: origin.`protocol`, host: origin.host, port: origin.port))
        let reply = await BridgeDispatcher.reply(
            to: message.body as? String, sender: sender, appURL: controller.appURL, host: controller)
        let encoded = reply.scriptReply
        return (encoded.result, encoded.error)
    }
}

/// Answers the helper document's two fixed callbacks (ADR-207). The reply only
/// acknowledges receipt; readiness is decided by the controller's session authority.
@MainActor
final class HelperDocumentMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var shell: WebShell?

    init(shell: WebShell) {
        self.shell = shell
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage)
        async -> (Any?, String?)
    {
        let rejected: (Any?, String?) = (nil, "Helper acknowledgement rejected")
        guard let shell, let controller = shell.controller, message.webView === shell.webView,
            let callback = try? NativeHelperDocumentBridge.decodeCallback(message.body as? String)
        else { return rejected }
        let origin = message.frameInfo.securityOrigin
        var parts = URLComponents()
        parts.scheme = origin.`protocol`
        parts.host = origin.host
        parts.port = origin.port == 0 ? nil : origin.port
        guard let securityOrigin = parts.url,
            let observation = shell.helperObservation(
                for: nil, isMainFrame: message.frameInfo.isMainFrame, securityOrigin: securityOrigin),
            controller.helperDocumentCallback(callback, observation: observation)
        else { return rejected }
        return ("{\"success\":true}", nil)
    }
}

/// Places the shell's one web view in the SwiftUI detail column (`ShellRootView`). The view
/// is created once by `WebShell` and only hidden while a native screen covers it, so the
/// page keeps its state and keeps reporting routes.
struct WebViewHost: NSViewRepresentable {
    let webView: ShellWebView
    let hidden: Bool

    func makeNSView(context: Context) -> ShellWebView {
        webView.isHidden = hidden
        return webView
    }

    func updateNSView(_ nsView: ShellWebView, context: Context) {
        guard nsView.isHidden != hidden else { return }
        nsView.isHidden = hidden
        // Back from a native screen: the page takes the keyboard again.
        if !hidden, let window = nsView.window { window.makeFirstResponder(nsView) }
    }
}
