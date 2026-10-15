import Foundation

/// Authority for asynchronous startup work belonging to one retained document.
/// A native graph can outlive a document, so its generation alone cannot fence
/// work resumed after an ordinary navigation or a renderer crash/reload.
public struct NativeRendererReadiness: Sendable {
    public struct Document: Equatable, Sendable {
        fileprivate let id = UUID()
    }

    private var document = Document()
    public private(set) var isReady = false
    public private(set) var isAwaitingCommit = false

    public init() {}

    /// The outgoing document can still send messages until WebKit commits the
    /// incoming navigation. None can establish readiness for that navigation.
    public mutating func willNavigate() {
        document = Document()
        isReady = false
        isAwaitingCommit = true
    }

    public mutating func documentDidCommit() {
        document = Document()
        isReady = false
        isAwaitingCommit = false
    }

    @discardableResult
    public mutating func markReady() -> Document? {
        guard !isAwaitingCommit else { return nil }
        isReady = true
        return document
    }

    public func isCurrentReady(_ candidate: Document) -> Bool {
        isReady && candidate == document
    }
}
