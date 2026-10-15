import Foundation

/// Session-owned native actions, independent of any one settings/model graph. The SDK
/// must opt in explicitly and keep this same object for an ordinary graph rebuild.
/// A restored authority needs its own session; this does not shorten restore/input fences.
@MainActor
public final class NativeShellIntentCoordinator {
    public enum Intent: Equatable, Sendable {
        case openCSV(ImportFile)
        case newTransaction
        case navigate(NativeNavigationLocation, replace: Bool)
        case openSettings(section: String)
        case closeSettings
        case setTheme(String)
        case toggleSidebar
        case openPalette
        case openShortcuts
        case traverse(Int)
    }

    /// A graph may consume only while all independent startup/input gates are open.
    public struct Readiness: Equatable, Sendable {
        public var document: Bool
        public var settings: Bool
        public var onboarding: Bool
        public var acceptingInput: Bool

        public init(document: Bool, settings: Bool, onboarding: Bool, acceptingInput: Bool) {
            self.document = document
            self.settings = settings
            self.onboarding = onboarding
            self.acceptingInput = acceptingInput
        }

        public var isReady: Bool { document && settings && onboarding && acceptingInput }
    }

    public struct Lease: Equatable, Sendable {
        fileprivate let id: UUID
    }

    public struct Attachment: Sendable {
        public let lease: Lease
        public let history: NativeNavigationHistory
    }

    private struct Handoff {
        let file: ImportFile
        let expiresAt: Date
    }

    private let now: @MainActor () -> Date
    private var lease: Lease?
    private var history: NativeNavigationHistory?
    private var queued: [Intent] = []
    private var handoff: Handoff?
    private var addOnArrival = false
    private var blockedColdNavigation: Intent?
    private var blockedColdSource: NativeNavigationHistory.Intent?
    private var isDraining = false

    public init(now: @escaping @MainActor () -> Date = Date.init) {
        self.now = now
    }

    /// Attaching a replacement revokes the old graph immediately. Only committed history
    /// visits survive: a Leave prompt belongs to the discarded graph's unsaved draft.
    public func attach(initialHistory: NativeNavigationHistory) -> Attachment {
        var next = history ?? initialHistory
        if history != nil { next.cancelPending() }
        if let blockedColdNavigation {
            queued.insert(blockedColdNavigation, at: 0)
            self.blockedColdNavigation = nil
            blockedColdSource = nil
        }
        history = next
        let nextLease = Lease(id: UUID())
        lease = nextLease
        return Attachment(lease: nextLease, history: next)
    }

    public func isCurrent(_ candidate: Lease) -> Bool { lease == candidate }

    public func checkpoint(_ history: NativeNavigationHistory, for candidate: Lease) {
        guard isCurrent(candidate) else { return }
        self.history = history
        if history.pending != blockedColdSource {
            blockedColdNavigation = nil
            blockedColdSource = nil
        }
    }

    /// Keep a blocked cold action's destination for reconstruction, without registering
    /// its file again or carrying a Leave prompt from the old unsaved draft.
    func preserveBlockedColdNavigation(
        _ pending: NativeNavigationHistory.Intent, newTransaction: Bool, for candidate: Lease
    ) {
        guard isCurrent(candidate) else { return }
        blockedColdSource = pending
        if newTransaction {
            blockedColdNavigation = .newTransaction
            return
        }
        switch pending {
        case .push(let location): blockedColdNavigation = .navigate(location, replace: false)
        case .replace(let location): blockedColdNavigation = .navigate(location, replace: true)
        case .traverse(let delta): blockedColdNavigation = .traverse(delta)
        }
    }

    /// Ingress belongs to the session (including an OS file read finishing during rebuild),
    /// rather than to an obsolete graph. Model callers must first check their lease.
    public func enqueue(_ intent: Intent) {
        queued.append(intent)
    }

    /// Native commands execute synchronously, in source event order. File registration
    /// starts its 30-second lifetime here, just as the source bridge registers a file only
    /// after receiving its queued event. Registered files are one-slot, latest wins.
    public func drain(for candidate: Lease, readiness: Readiness, perform: (Intent) -> Void) {
        guard isCurrent(candidate), readiness.isReady, !isDraining else { return }
        isDraining = true
        defer { isDraining = false }
        while isCurrent(candidate), !queued.isEmpty {
            let intent = queued.removeFirst()
            switch intent {
            case .openCSV(let file):
                handoff = Handoff(file: file, expiresAt: now().addingTimeInterval(30))
            case .newTransaction: addOnArrival = true
            default: break
            }
            perform(intent)
        }
    }

    /// Delivery is acknowledged only by a ready native consumer. Reattaching cannot
    /// restart this absolute expiry or replay a file that was already chosen.
    public func consumeCSV(for candidate: Lease, consumerReady: Bool) -> ImportFile? {
        guard isCurrent(candidate), consumerReady, let pending = handoff else { return nil }
        handoff = nil
        return now() <= pending.expiresAt ? pending.file : nil
    }

    public func consumeNewTransaction(for candidate: Lease, consumerReady: Bool) -> Bool {
        guard isCurrent(candidate), consumerReady, addOnArrival else { return false }
        addOnArrival = false
        return true
    }

    /// A committed departure or Stay cancels the sheet that belonged to that navigation.
    /// Repeated requests on the destination still reuse its existing native Add form.
    public func cancelNewTransaction(for candidate: Lease) {
        guard isCurrent(candidate) else { return }
        addOnArrival = false
    }
}
