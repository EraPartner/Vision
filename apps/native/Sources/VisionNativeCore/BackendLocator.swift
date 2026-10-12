import Foundation

/// Where the located backend URL came from.
public enum BackendSource: Equatable, Sendable {
    case environment
    case demoSettings
}

public struct LocatedBackend: Equatable, Sendable {
    public let baseURL: URL
    public let source: BackendSource

    public init(baseURL: URL, source: BackendSource) {
        self.baseURL = baseURL
        self.source = source
    }
}

public enum BackendLocatorError: Error, Equatable, Sendable {
    /// `VISION_NATIVE_BACKEND_URL` is set but is not an absolute http(s) URL with a host.
    case malformedEnvironmentURL(String)
}

/// Resolves the Vision backend base URL. Vision Native runs on the synthetic Demo
/// dataset only (ADR-203), so the fallback reads the Vision Demo app's settings.
public enum BackendLocator {
    public static let environmentKey = "VISION_NATIVE_BACKEND_URL"
    /// Matches `DEMO_USER_DATA_NAME` in `packaging/electron/runtime/native-demo.ts`.
    public static let demoUserDataName = "Vision Demo"
    /// Same bounds as `resolveAppPort` in `packaging/electron/main.ts`.
    public static let appPortRange = 1024...65535

    /// Resolution order: the environment variable, then `appPort` in the Vision Demo
    /// `settings.json`, else `nil`. A set but malformed environment URL throws instead
    /// of silently falling back.
    public static func locate(
        environment: [String: String],
        homeDirectory: URL,
        readFile: (URL) throws -> Data
    ) throws -> LocatedBackend? {
        if let raw = environment[environmentKey], !raw.isEmpty {
            guard let url = parseBaseURL(raw) else {
                throw BackendLocatorError.malformedEnvironmentURL(raw)
            }
            return LocatedBackend(baseURL: url, source: .environment)
        }
        guard let data = try? readFile(demoSettingsURL(homeDirectory: homeDirectory)),
            let port = parseAppPort(settings: data),
            let url = URL(string: "http://localhost:\(port)")
        else {
            return nil
        }
        return LocatedBackend(baseURL: url, source: .demoSettings)
    }

    /// `~/Library/Application Support/Vision Demo/settings.json`, written by the
    /// Electron Vision Demo app. Vision Native only reads it.
    public static func demoSettingsURL(homeDirectory: URL) -> URL {
        homeDirectory
            .appendingPathComponent("Library", isDirectory: true)
            .appendingPathComponent("Application Support", isDirectory: true)
            .appendingPathComponent(demoUserDataName, isDirectory: true)
            .appendingPathComponent("settings.json", isDirectory: false)
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

    /// Returns the integer `appPort` from Demo `settings.json`, or `nil` when the JSON is
    /// invalid, the key is missing, the value is not an integer or it is out of range.
    public static func parseAppPort(settings data: Data) -> Int? {
        guard let settings = try? JSONDecoder().decode(DemoSettings.self, from: data),
            let port = settings.appPort,
            appPortRange.contains(port)
        else {
            return nil
        }
        return port
    }

    private struct DemoSettings: Decodable {
        let appPort: Int?
    }
}
