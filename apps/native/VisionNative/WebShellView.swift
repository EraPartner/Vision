import OSLog
import SwiftUI
import VisionNativeCore
import WebKit

/// What the window shows: a check in progress, the web shell, or the reason the
/// backend is unavailable.
enum ShellState: Equatable, Sendable {
    case checking
    case ready(URL)
    case unavailable(String)
}

enum ShellResolver {
    /// Debug builds honour a loopback `VISION_NATIVE_BACKEND_URL` and skip supervision;
    /// otherwise Vision Native starts its own PostgreSQL and backend and waits until the
    /// backend is ready.
    static func resolve() async -> ShellState {
        #if DEBUG
            let allowOverride = true
        #else
            let allowOverride = false
        #endif
        switch BackendLocator.developerOverride(
            environment: ProcessInfo.processInfo.environment, allowOverride: allowOverride)
        {
        case .use(let url):
            return await checkOverride(url)
        case .ignored(let reason):
            AppRuntime.logger.warning("\(reason, privacy: .public)")
        case .none:
            break
        }
        do {
            return .ready(try await AppRuntime.supervisor.launch())
        } catch {
            let reason = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            return .unavailable(reason)
        }
    }

    /// The developer override must answer `GET /health` with 200.
    private static func checkOverride(_ baseURL: URL) async -> ShellState {
        let healthURL = BackendHealth.healthURL(baseURL: baseURL)
        do {
            let status = try await BackendHealth.status(baseURL: baseURL)
            guard status == 200 else {
                return .unavailable("\(healthURL.absoluteString) answered HTTP \(status).")
            }
            return .ready(baseURL)
        } catch {
            return .unavailable(
                "The backend is not running at \(healthURL.absoluteString): \(error.localizedDescription)"
            )
        }
    }
}

struct ShellRootView: View {
    @State private var state: ShellState = .checking
    @State private var attempt = 0

    var body: some View {
        content
            .frame(minWidth: 800, minHeight: 500)
            .task(id: attempt) {
                state = .checking
                state = await ShellResolver.resolve()
            }
    }

    @ViewBuilder
    private var content: some View {
        switch state {
        case .checking:
            ProgressView("Connecting to the Vision backend…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .ready(let url):
            WebShellView(url: url)
        case .unavailable(let reason):
            VStack(spacing: 12) {
                Text("Backend not running")
                    .font(.title2)
                Text(reason)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .textSelection(.enabled)
                Button("Retry") {
                    attempt += 1
                }
                .keyboardShortcut(.defaultAction)
            }
            .padding(32)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

/// Hosts the React frontend served by the backend in a `WKWebView` (phase 1 of ADR-204).
struct WebShellView: NSViewRepresentable {
    let url: URL

    final class Coordinator {
        var loadedURL: URL?
    }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        #if DEBUG
            // Enables the Safari Web Inspector (developer extras) in Debug builds only.
            webView.isInspectable = true
        #endif
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.loadedURL != url else { return }
        context.coordinator.loadedURL = url
        webView.load(URLRequest(url: url))
    }
}
