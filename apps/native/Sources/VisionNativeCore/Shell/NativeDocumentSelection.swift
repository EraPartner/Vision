import Foundation

/// Where the shell's backend came from. Only the app's own supervisor launch can
/// vouch for the Demo runtime; a healthy developer override never can (ADR-207).
public enum NativeShellBackendSource: Equatable, Sendable {
    case supervised(runtimeIdentifier: String)
    case developerOverride
}

/// The supervised Demo origin and website data store a native-only document owns. Only a Debug
/// build of the Demo variant whose own supervisor launched `vision_native_demo` at a loopback
/// origin qualifies (ADR-207's eligibility rules, kept by ADR-208 and ADR-209).
public struct NativeDocumentSource: Equatable, Sendable {
    public enum SourceError: Error, Equatable, Sendable { case ineligibleSession, invalidSource }

    public let backendOrigin: URL
    public let websiteDataStoreIdentifier: String

    public init(
        isDebugBuild: Bool, rawVariant: String?, runtimeIdentifier: String, backendURL: URL,
        websiteDataStoreIdentifier: String
    ) throws {
        guard isDebugBuild, rawVariant == "demo", runtimeIdentifier == "vision_native_demo" else {
            throw SourceError.ineligibleSession
        }
        guard
            var parts = URLComponents(url: backendURL, resolvingAgainstBaseURL: false),
            let scheme = parts.scheme, ["http", "https"].contains(scheme),
            let host = parts.host, ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
            parts.user == nil, parts.password == nil, !backendURL.absoluteString.contains("@"),
            parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
            parts.port.map({ (1...65535).contains($0) }) ?? true,
            !websiteDataStoreIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { throw SourceError.invalidSource }
        // Match the browser's canonical location.href spelling.
        if (scheme == "http" && parts.port == 80) || (scheme == "https" && parts.port == 443) {
            parts.port = nil
        }
        parts.path = ""
        guard let origin = parts.url else { throw SourceError.invalidSource }
        backendOrigin = origin
        self.websiteDataStoreIdentifier = websiteDataStoreIdentifier
    }
}

/// Chooses the document presentation once, before the session creates its first document.
/// Within the eligibility rules, ADR-208's native-only mode is the default and an exact
/// `VISION_NATIVE_WEB_FREE=0` opts out. Everything else, including any ineligible launch, keeps
/// the retained web document (ADR-209 retired the helper document).
public enum NativeDocumentSelection: Equatable, Sendable {
    public static let nativeOnlyEnvironmentKey = "VISION_NATIVE_WEB_FREE"

    case retainedWeb
    /// The source identifies the supervised origin and website data store whose storage the
    /// native raw-state store captures once.
    case nativeOnly(NativeDocumentSource)

    public var presentationMode: NativeShellPresentationMode {
        switch self {
        case .retainedWeb: return .retainedWeb
        case .nativeOnly: return .nativeOnly
        }
    }

    public static func select(
        environment: [String: String], isDebugBuild: Bool, rawVariant: String?,
        backendSource: NativeShellBackendSource, backendURL: URL, websiteDataStoreIdentifier: String
    ) -> NativeDocumentSelection {
        guard environment[nativeOnlyEnvironmentKey] != "0",
            case .supervised(let runtimeIdentifier) = backendSource,
            let source = try? NativeDocumentSource(
                isDebugBuild: isDebugBuild, rawVariant: rawVariant, runtimeIdentifier: runtimeIdentifier,
                backendURL: backendURL, websiteDataStoreIdentifier: websiteDataStoreIdentifier)
        else { return .retainedWeb }
        return .nativeOnly(source)
    }
}
