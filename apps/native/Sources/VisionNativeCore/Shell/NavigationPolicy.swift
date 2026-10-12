import Foundation

/// The fixed external links (`REPOSITORY_URL`, `DOCUMENTATION_URL` in packaging/electron/main.ts).
public enum ShellLinks {
    public static let repository = "https://github.com/EraPartner/Vision"
    public static let documentation = "https://github.com/EraPartner/Vision/tree/main/docs"
    /// `TRUSTED_EXTERNAL_URLS`: the only URLs the shell hands to the default browser, compared
    /// as exact strings like `openTrustedExternalUrl`.
    public static let trustedExternal: Set<String> = [repository, documentation]

    public static func trustedExternalURL(_ url: URL?) -> URL? {
        guard let url, trustedExternal.contains(url.absoluteString) else { return nil }
        return url
    }
}

/// What the web view does with a navigation, a new-window request or a response.
public enum NavigationDecision: Equatable, Sendable {
    case allow
    /// Save the resource through `WKDownload` and the save panel.
    case download
    /// Cancel in the web view and open the URL in the default browser.
    case openExternally(URL)
    /// Cancel; the reason is logged.
    case cancel(String)
}

/// The web view policy of `createWindow` in packaging/electron/main.ts
/// (`will-frame-navigate`, `will-redirect`, `setWindowOpenHandler`), plus downloads.
public enum NavigationPolicy {
    /// `isTrustedRendererUrl` for an http(s) document: the backend's scheme, host and port,
    /// without credentials.
    public static func isAppURL(_ url: URL, appURL: URL) -> Bool {
        guard let candidate = URLComponents(url: url, resolvingAgainstBaseURL: false),
            let app = URLComponents(url: appURL, resolvingAgainstBaseURL: false),
            let scheme = candidate.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            scheme == app.scheme?.lowercased(),
            candidate.user == nil, candidate.password == nil,
            let host = candidate.host?.lowercased(), !host.isEmpty,
            host == app.host?.lowercased()
        else {
            return false
        }
        return effectivePort(candidate) == effectivePort(app)
    }

    private static func effectivePort(_ components: URLComponents) -> Int {
        if let port = components.port { return port }
        return components.scheme?.lowercased() == "https" ? 443 : 80
    }

    /// A `data:` URL, or a `blob:` URL created by the app's own origin.
    public static func isInPageResource(_ url: URL, appURL: URL) -> Bool {
        switch url.scheme?.lowercased() {
        case "data":
            return true
        case "blob":
            let inner = String(url.absoluteString.dropFirst("blob:".count))
            guard let innerURL = URL(string: inner) else { return false }
            return isAppURL(innerURL, appURL: appURL)
        default:
            return false
        }
    }

    /// A navigation in any frame. The app origin loads; `<a download>` of an in-page or app
    /// resource becomes a download; a trusted external link opens in the default browser;
    /// everything else is cancelled. Subframes may also load `about:blank` and `about:srcdoc`.
    public static func decideNavigation(
        url: URL?, isMainFrame: Bool, shouldPerformDownload: Bool, appURL: URL
    ) -> NavigationDecision {
        guard let url else { return .cancel("navigation without a URL") }
        if shouldPerformDownload {
            if isAppURL(url, appURL: appURL) || isInPageResource(url, appURL: appURL) { return .download }
            return .cancel("download from an untrusted origin")
        }
        if isAppURL(url, appURL: appURL) { return .allow }
        if !isMainFrame, url.absoluteString == "about:blank" || url.absoluteString == "about:srcdoc" {
            return .allow
        }
        if let external = ShellLinks.trustedExternalURL(url) { return .openExternally(external) }
        return .cancel("navigation to an untrusted URL")
    }

    /// `window.open` and `target="_blank"`: never a second web view. Trusted links open in the
    /// default browser, everything else is denied (`setWindowOpenHandler`).
    public static func decideNewWindow(url: URL?) -> NavigationDecision {
        if let external = ShellLinks.trustedExternalURL(url) { return .openExternally(external) }
        return .cancel("new window for an untrusted URL")
    }

    /// A response the web view cannot show, or one sent as an attachment, is saved as a
    /// download when it comes from the app origin or the page itself; otherwise it is cancelled.
    public static func decideResponse(
        url: URL?, canShowMIMEType: Bool, contentDisposition: String?, appURL: URL
    ) -> NavigationDecision {
        let isAttachment =
            contentDisposition?.trimmingCharacters(in: .whitespaces).lowercased().hasPrefix("attachment") ?? false
        guard isAttachment || !canShowMIMEType else { return .allow }
        guard let url, isAppURL(url, appURL: appURL) || isInPageResource(url, appURL: appURL) else {
            return .cancel("download from an untrusted origin")
        }
        return .download
    }

    /// The name the save panel proposes: the last path component, without characters that
    /// Finder cannot show, and never empty.
    public static func downloadFilename(_ suggested: String) -> String {
        let lastComponent = suggested.split(separator: "/").last.map(String.init) ?? ""
        let cleaned = lastComponent.replacingOccurrences(of: ":", with: "-")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return cleaned.isEmpty || cleaned == "." || cleaned == ".." ? "download" : cleaned
    }
}
