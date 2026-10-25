/// Display readiness supplied by the native document owner: the shell host sets `ready` once
/// its storage is open and the shell graph is built, and `failed` when it cannot start.
public enum NativeDocumentState: Equatable, Sendable {
    case loading
    case ready
    case failed
}

/// Presentation eligibility only; operation, restore and overlay guards still apply in the SDK.
public enum NativeShellPrintDisposition: Equatable, Sendable {
    case unavailable
    case nativePage
}
