import AppKit
import OSLog
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

    init(controller: ShellController) {
        let contentController = WKUserContentController()
        contentController.addUserScript(
            WKUserScript(source: BridgeScript.source, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = contentController
        configuration.websiteDataStore = .default()
        webView = ShellWebView(frame: .zero, configuration: configuration)
        self.controller = controller
        super.init()
        contentController.addScriptMessageHandler(
            BridgeMessageHandler(shell: self), contentWorld: .page, name: BridgeContract.messageHandlerName)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        #if DEBUG
            // Enables the Safari Web Inspector (developer extras) in Debug builds only.
            webView.isInspectable = true
        #endif
    }

    func load(_ url: URL) {
        webView.load(URLRequest(url: url))
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

extension WebShell: @preconcurrency WKNavigationDelegate {
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
            url: response.url, canShowMIMEType: navigationResponse.canShowMIMEType, contentDisposition: disposition,
            appURL: appURL)
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

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        controller?.documentDidStart()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        controller?.documentDidFinish()
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        let nsError = error as NSError
        // A superseded load (-999) or one the policy turned into a download (102) is not a failure.
        if nsError.domain == NSURLErrorDomain && nsError.code == NSURLErrorCancelled { return }
        if nsError.domain == "WebKitErrorDomain" && nsError.code == 102 { return }
        controller?.documentDidFail(error)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // Electron logs `render-process-gone`; WebKit leaves a blank view, so reload as well.
        logger.error("[renderer] web content process terminated; reloading")
        webView.reload()
    }
}

extension WebShell: @preconcurrency WKUIDelegate {
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
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType
    ) async -> WKPermissionDecision {
        .deny
    }
}

extension WebShell: @preconcurrency WKDownloadDelegate {
    /// Electron's default download behaviour: a save panel in Downloads with the suggested name.
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async
        -> URL?
    {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = NavigationPolicy.downloadFilename(suggestedFilename)
        panel.canCreateDirectories = true
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        guard await run(panel) == .OK, let url = panel.url else { return nil }
        // The panel already confirmed the replacement, and WKDownload refuses an existing file.
        if FileManager.default.fileExists(atPath: url.path) {
            do {
                try FileManager.default.removeItem(at: url)
            } catch {
                logger.error("download: could not replace the existing file: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        logger.log("download finished")
    }

    func download(_ download: WKDownload, didFailWithError error: any Error, resumeData: Data?) {
        logger.error("download failed: \(error.localizedDescription, privacy: .public)")
    }
}

/// Answers `window.webkit.messageHandlers.visionNative.postMessage(...)`; the promise
/// resolves with the reply's JSON text or rejects with its error message.
@MainActor
final class BridgeMessageHandler: NSObject, @preconcurrency WKScriptMessageHandlerWithReply {
    private weak var shell: WebShell?

    init(shell: WebShell) {
        self.shell = shell
        super.init()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage)
        async -> (Any?, String?)
    {
        guard let controller = shell?.controller else { return (nil, BridgeDispatcher.unauthorizedSenderMessage) }
        let sender = BridgeSender(isMainFrame: message.frameInfo.isMainFrame, url: message.frameInfo.request.url)
        let reply = await BridgeDispatcher.reply(
            to: message.body as? String, sender: sender, appURL: controller.appURL, host: controller)
        let encoded = reply.scriptReply
        return (encoded.result, encoded.error)
    }
}
