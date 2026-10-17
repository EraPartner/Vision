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

    case retainedWeb
    case helperDocument(NativeHelperDocumentSession.Source)

    public var presentationMode: NativeShellPresentationMode {
        switch self {
        case .retainedWeb: return .retainedWeb
        case .helperDocument: return .helperDocument
        }
    }

    public static func select(
        environment: [String: String], isDebugBuild: Bool, rawVariant: String?,
        backendSource: NativeShellBackendSource, backendURL: URL, websiteDataStoreIdentifier: String
    ) -> NativeHelperDocumentSelection {
        guard environment[environmentKey] == "1",
            case .supervised(let runtimeIdentifier) = backendSource
        else { return .retainedWeb }
        let receipt = NativeHelperDocumentSession.SupervisorDemoReceipt(
            runtimeIdentifier: runtimeIdentifier, backendOrigin: backendURL)
        guard
            let source = try? NativeHelperDocumentSession.Source(
                isDebugBuild: isDebugBuild, rawVariant: rawVariant, supervisorReceipt: receipt,
                websiteDataStoreIdentifier: websiteDataStoreIdentifier)
        else { return .retainedWeb }
        return .helperDocument(source)
    }
}
