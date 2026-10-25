import Foundation
import VisionNativeCore
import WebKit

/// ADR-211's one-time capture (owner decision 2026-10-17): before the first native-only
/// graph exists, a transient, unpresented web view loads the backend's `/health` document at
/// the supervised origin, which runs no application script, reads that origin's browser
/// storage with `NativeRawStateCaptureBridge` and is released. No other writer exists yet, so
/// the capture is exclusive. Every failure is thrown; nothing is assumed.
@MainActor
final class NativeStorageCapture: NSObject, WKNavigationDelegate {
    private let webView: WKWebView
    private var loading: CheckedContinuation<Void, any Error>?

    private override init() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        webView = WKWebView(frame: .zero, configuration: configuration)
        super.init()
        webView.navigationDelegate = self
    }

    static func capture(source: NativeRawStateStore.Source, origin: URL) async throws
        -> NativeRawStateStore.MigrationCapture
    {
        let capture = NativeStorageCapture()
        defer { capture.webView.navigationDelegate = nil }
        try await capture.load(origin.appendingPathComponent("health"))
        let request = try NativeRawStateCaptureBridge.Request(
            source: source, captureID: UUID(), documentID: UUID(), generationID: UUID())
        let bound =
            try JSONSerialization.jsonObject(
                with: JSONValue.object(NativeRawStateCaptureBridge.arguments(for: request)).serialized())
            as? [String: Any] ?? [:]
        let reply = try await capture.webView.callAsyncJavaScript(
            NativeRawStateCaptureBridge.script, arguments: bound, in: nil, contentWorld: .page)
        guard let text = reply as? String else { throw NativeRawStateCaptureBridge.CaptureError.invalidReply }
        return try NativeRawStateCaptureBridge.decodeReply(.string(text), for: request)
    }

    private func load(_ url: URL) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, any Error>) in
            loading = continuation
            webView.load(URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 15))
        }
    }

    private func finish(_ result: Result<Void, any Error>) {
        let waiting = loading
        loading = nil
        waiting?.resume(with: result)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        finish(.success(()))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: any Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: any Error) {
        finish(.failure(error))
    }
}
