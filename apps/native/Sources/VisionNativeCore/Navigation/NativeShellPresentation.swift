/// Document presentation is fixed before the session creates its first document.
/// `nativeOnly` has no web document at all and gives native history every route (ADR-211);
/// `retainedWeb` shows the React page (ADR-212 retired the helper document).
public enum NativeShellPresentationMode: Equatable, Sendable {
    case retainedWeb
    case nativeOnly

    /// Native presentation and route authority: no React page is ever shown.
    public var isNative: Bool { self != .retainedWeb }
}

/// Display readiness supplied by the native document owner, separate from renderer readiness.
public enum NativeDocumentState: Equatable, Sendable {
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
