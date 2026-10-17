import Foundation

/// Where the shell's backend came from. Only the app's own supervisor launch can
/// vouch for the Demo runtime; a healthy developer override never can (ADR-207).
public enum NativeShellBackendSource: Equatable, Sendable {
    case supervised(runtimeIdentifier: String)
    case developerOverride
}

/// Chooses the document presentation once, before the session creates its web document.
/// The helper experiment needs an explicit opt-in on top of every ADR-207 eligibility rule;
/// everything else, including any ineligible opt-in, keeps the retained web presentation.
public enum NativeHelperDocumentSelection: Equatable, Sendable {
    public static let environmentKey = "VISION_NATIVE_HELPER_DOCUMENT"
    /// ADR-208's default-off opt-in for the mode without any web document; it takes
    /// precedence over the helper document under the same eligibility rules.
    public static let nativeOnlyEnvironmentKey = "VISION_NATIVE_WEB_FREE"

    case retainedWeb
    case helperDocument(NativeHelperDocumentSession.Source)
    /// The source identifies the supervised origin and website data store whose storage the
    /// native raw-state store captures once.
    case nativeOnly(NativeHelperDocumentSession.Source)

    public var presentationMode: NativeShellPresentationMode {
        switch self {
        case .retainedWeb: return .retainedWeb
        case .helperDocument: return .helperDocument
        case .nativeOnly: return .nativeOnly
        }
    }

    public static func select(
        environment: [String: String], isDebugBuild: Bool, rawVariant: String?,
        backendSource: NativeShellBackendSource, backendURL: URL, websiteDataStoreIdentifier: String
    ) -> NativeHelperDocumentSelection {
        let nativeOnly = environment[nativeOnlyEnvironmentKey] == "1"
        guard environment[environmentKey] == "1" || nativeOnly,
            case .supervised(let runtimeIdentifier) = backendSource
        else { return .retainedWeb }
        let receipt = NativeHelperDocumentSession.SupervisorDemoReceipt(
            runtimeIdentifier: runtimeIdentifier, backendOrigin: backendURL)
        guard
            let source = try? NativeHelperDocumentSession.Source(
                isDebugBuild: isDebugBuild, rawVariant: rawVariant, supervisorReceipt: receipt,
                websiteDataStoreIdentifier: websiteDataStoreIdentifier)
        else { return .retainedWeb }
        return nativeOnly ? .nativeOnly(source) : .helperDocument(source)
    }
}
