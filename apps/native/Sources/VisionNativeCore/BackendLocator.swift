import Foundation

/// What to do with the `VISION_NATIVE_BACKEND_URL` developer override.
public enum BackendOverride: Equatable, Sendable {
    /// Not set: Vision Native supervises its own runtime.
    case none
    /// Use this backend and skip supervision.
    case use(URL)
    /// Set but not honoured; the reason is logged and the app supervises its own runtime.
    case ignored(String)
}

/// The developer override that points the web shell at an already running backend.
/// Vision Native otherwise starts its own runtime (`RuntimeSupervisor`) and never
/// connects to another app's backend.
public enum BackendLocator {
    public static let environmentKey = "VISION_NATIVE_BACKEND_URL"
    public static let loopbackHosts: Set<String> = ["localhost", "127.0.0.1", "::1"]

    /// Honoured only when `allowOverride` (Debug builds) and only for an absolute
    /// `http`/`https` URL on a loopback host, so a Release build can never be pointed
    /// at another backend.
    public static func developerOverride(environment: [String: String], allowOverride: Bool) -> BackendOverride {
        guard let raw = environment[environmentKey], !raw.isEmpty else { return .none }
        guard allowOverride else {
            return .ignored("\(environmentKey) is ignored in Release builds.")
        }
        guard let url = parseBaseURL(raw) else {
            return .ignored("\(environmentKey) is not an absolute http(s) URL with a host: \(raw)")
        }
        let host = (URLComponents(url: url, resolvingAgainstBaseURL: false)?.host ?? "")
            .trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        guard loopbackHosts.contains(host) else {
            return .ignored("\(environmentKey) must point to localhost, 127.0.0.1 or ::1: \(raw)")
        }
        return .use(url)
    }

    /// Accepts an absolute `http` or `https` URL with a host and no query or fragment.
    public static func parseBaseURL(_ raw: String) -> URL? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let components = URLComponents(string: trimmed),
            let scheme = components.scheme?.lowercased(),
            scheme == "http" || scheme == "https",
            let host = components.host,
            !host.isEmpty,
            components.query == nil,
            components.fragment == nil
        else {
            return nil
        }
        return components.url
    }
}
