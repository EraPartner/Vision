/// Document presentation is fixed before the session creates its web document.
/// The SDK continues to use retainedWeb until the helper-document experiment is integrated.
public enum NativeShellPresentationMode: Equatable, Sendable {
    case retainedWeb
    case helperDocument
}

/// Display readiness supplied by the native document owner, separate from renderer readiness.
public enum NativeHelperDocumentState: Equatable, Sendable {
    case loading
    case ready
    case failed
}

/// Presentation eligibility only; operation, restore and overlay guards still apply in the SDK.
public enum NativeShellPrintDisposition: Equatable, Sendable {
    case unavailable
    case webDocument
    case nativePage
}
