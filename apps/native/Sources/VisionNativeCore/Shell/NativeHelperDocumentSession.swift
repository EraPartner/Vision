import Foundation

/// Dormant host authority for ADR-207. No launcher flag or SDK mode is enabled here.
/// Tokens correlate trusted WebKit observations; renderer echoes never establish them.
public struct NativeHelperDocumentSession: Sendable {
    public enum SessionError: Error, Equatable, Sendable {
        case ineligibleSession, invalidSource, foreignSource, staleNavigation, invalidPhase,
            staleDocument
    }

    /// The future selector must obtain this from its own Demo supervisor launch,
    /// never from a healthy developer-override URL or a renderer assertion.
    public struct SupervisorDemoReceipt: Sendable {
        public let runtimeIdentifier: String
        public let backendOrigin: URL

        public init(runtimeIdentifier: String, backendOrigin: URL) {
            self.runtimeIdentifier = runtimeIdentifier
            self.backendOrigin = backendOrigin
        }
    }

    public struct Source: Equatable, Sendable {
        public let backendOrigin: URL
        public let helperURL: URL
        public let websiteDataStoreIdentifier: String

        public init(
            isDebugBuild: Bool, rawVariant: String?, supervisorReceipt: SupervisorDemoReceipt,
            websiteDataStoreIdentifier: String
        ) throws {
            guard isDebugBuild, rawVariant == "demo",
                supervisorReceipt.runtimeIdentifier == "vision_native_demo"
            else { throw SessionError.ineligibleSession }
            guard
                var parts = URLComponents(
                    url: supervisorReceipt.backendOrigin, resolvingAgainstBaseURL: false),
                let scheme = parts.scheme, ["http", "https"].contains(scheme),
                let host = parts.host, ["127.0.0.1", "localhost", "[::1]", "::1"].contains(host),
                parts.user == nil, parts.password == nil,
                !supervisorReceipt.backendOrigin.absoluteString.contains("@"),
                parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/",
                parts.port.map({ (1...65535).contains($0) }) ?? true,
                !websiteDataStoreIdentifier.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { throw SessionError.invalidSource }
            // Match the browser's canonical location.href spelling.
            if (scheme == "http" && parts.port == 80) || (scheme == "https" && parts.port == 443) {
                parts.port = nil
            }
            parts.path = ""
            guard let origin = parts.url else { throw SessionError.invalidSource }
            parts.path = "/native-helper.html"
            guard let helperURL = parts.url else { throw SessionError.invalidSource }
            backendOrigin = origin
            self.helperURL = helperURL
            self.websiteDataStoreIdentifier = websiteDataStoreIdentifier
        }

        public func accepts(documentURL: URL, websiteDataStoreIdentifier: String) -> Bool {
            documentURL.absoluteString == helperURL.absoluteString
                && websiteDataStoreIdentifier == self.websiteDataStoreIdentifier
        }

        public func acceptsSecurityOrigin(_ origin: URL) -> Bool {
            guard let parts = URLComponents(url: origin, resolvingAgainstBaseURL: false),
                let expected = URLComponents(url: backendOrigin, resolvingAgainstBaseURL: false),
                parts.user == nil, parts.password == nil, !origin.absoluteString.contains("@"),
                parts.query == nil, parts.fragment == nil, parts.path.isEmpty || parts.path == "/"
            else { return false }
            let port = { (parts: URLComponents) in parts.port ?? (parts.scheme == "https" ? 443 : 80) }
            return parts.scheme == expected.scheme && parts.host == expected.host
                && port(parts) == port(expected)
        }
    }

    public struct Provenance: Equatable, Sendable {
        public let documentID: UUID
        public let generationID: UUID

        public init(documentID: UUID, generationID: UUID) {
            self.documentID = documentID
            self.generationID = generationID
        }
    }

    /// Supplied exclusively from the expected WKWebView/frame/store and an opaque
    /// native mapping of the actual WKNavigation object; never decoded from JS.
    public struct Observation: Sendable {
        public let navigationID: UUID
        public let documentURL: URL
        public let websiteDataStoreIdentifier: String
        public let isMainFrame: Bool
        public let securityOrigin: URL

        public init(
            navigationID: UUID, documentURL: URL, websiteDataStoreIdentifier: String,
            isMainFrame: Bool, securityOrigin: URL
        ) {
            self.navigationID = navigationID
            self.documentURL = documentURL
            self.websiteDataStoreIdentifier = websiteDataStoreIdentifier
            self.isMainFrame = isMainFrame
            self.securityOrigin = securityOrigin
        }
    }

    public enum Phase: Equatable, Sendable {
        case idle, navigating, committed, bootstrapping, ready, failed, retired
    }

    public let source: Source
    public let generationID: UUID
    public private(set) var phase: Phase = .idle
    public private(set) var provenance: Provenance?
    private var navigationID: UUID?
    private var launchReceiptAccepted = false
    private var readyCallbackAccepted = false

    public init(source: Source, generationID: UUID) {
        self.source = source
        self.generationID = generationID
    }

    /// Called before loading/reloading, including process-crash replacement.
    /// Retirement is final; graph replacement constructs a new session authority.
    public mutating func beginNavigation(_ navigationID: UUID) throws {
        guard phase != .retired else { throw SessionError.invalidPhase }
        self.navigationID = navigationID
        provenance = Provenance(documentID: UUID(), generationID: generationID)
        launchReceiptAccepted = false
        readyCallbackAccepted = false
        phase = .navigating
    }

    public mutating func didCommit(_ observation: Observation) throws {
        try requireObservation(observation)
        guard phase == .navigating else { throw SessionError.invalidPhase }
        phase = .committed
    }

    /// A commit can precede module evaluation. Only the matching finish issues
    /// bootstrap authority, before the host starts its fixed direct WebKit call.
    public mutating func didFinish(_ observation: Observation) throws -> Provenance {
        try requireObservation(observation)
        guard phase == .committed, let provenance else { throw SessionError.invalidPhase }
        phase = .bootstrapping
        return provenance
    }

    public mutating func acceptBootstrapReceipt(
        _ receipt: NativeHelperDocumentBridge.Receipt, observation: Observation
    ) throws {
        try requireObservation(observation)
        guard case .started(let candidate) = receipt else { throw SessionError.invalidPhase }
        try requireIssued(candidate)
        launchReceiptAccepted = true
        publishReadyIfComplete()
    }

    /// The host may ACK the ready callback before the bootstrap call physically
    /// returns. Startup stays fenced until BOTH independently checked receipts.
    public mutating func acceptCallback(
        _ callback: NativeHelperDocumentBridge.Callback, observation: Observation
    ) throws {
        try requireObservation(observation)
        switch callback {
        case .ready(let candidate):
            try requireIssued(candidate)
            readyCallbackAccepted = true
            publishReadyIfComplete()
        case .failed(let candidate):
            try requireIssued(candidate)
            phase = .failed
        }
    }

    public func requireCurrentReady(_ candidate: Provenance, observation: Observation) throws {
        try requireObservation(observation)
        guard phase == .ready else { throw SessionError.invalidPhase }
        guard candidate == provenance else { throw SessionError.staleDocument }
    }

    /// Logical failure never permits a late physical result to reopen input.
    public mutating func fail() { if phase != .retired { phase = .failed } }
    public mutating func retire() { phase = .retired }

    private func requireObservation(_ observation: Observation) throws {
        guard observation.navigationID == navigationID else { throw SessionError.staleNavigation }
        guard observation.isMainFrame,
            source.accepts(
                documentURL: observation.documentURL,
                websiteDataStoreIdentifier: observation.websiteDataStoreIdentifier),
            source.acceptsSecurityOrigin(observation.securityOrigin)
        else { throw SessionError.foreignSource }
    }

    private func requireIssued(_ candidate: Provenance) throws {
        guard phase == .bootstrapping || phase == .ready else { throw SessionError.invalidPhase }
        guard candidate == provenance else { throw SessionError.staleDocument }
    }

    private mutating func publishReadyIfComplete() {
        if launchReceiptAccepted && readyCallbackAccepted { phase = .ready }
    }
}
