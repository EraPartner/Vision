/// Document presentation is fixed before the session creates its web document.
/// `helperDocument` keeps a hidden same-origin document (ADR-207); `nativeOnly` has no web
/// document at all (ADR-208). Both give native history every route.
public enum NativeShellPresentationMode: Equatable, Sendable {
    case retainedWeb
    case helperDocument
    case nativeOnly

    /// Native presentation and route authority: no React page is ever shown.
    public var isNative: Bool { self != .retainedWeb }
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
