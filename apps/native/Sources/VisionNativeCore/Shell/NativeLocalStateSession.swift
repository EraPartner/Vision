import Foundation

/// One factory graph's authority to mutate the shell's local storage (`NativeRawStateStore`).
/// A restore drains accepted writes and holds late receipt handlers until it either resumes
/// the same storage or retires the original graph.
public actor NativeLocalStateSession {
    private enum State { case active, paused, retired }
    private var state = State.active
    private var activeWrites: Set<UUID> = []
    private var admissions: [UUID: CheckedContinuation<UUID, any Error>] = [:]
    private var drains: [CheckedContinuation<Void, Never>] = []

    // Gated lifecycle tests observe admission without arbitrary timing sleeps.
    var isSuspended: Bool { state == .paused }
    var pendingWriteCount: Int { admissions.count }
    var activeWriteCount: Int { activeWrites.count }

    public init() {}

    /// The host must finish every returned token after the actual storage operation
    /// completes, including failed and cancelled operations. Caller cancellation
    /// cannot establish that an accepted storage mutation stopped executing.
    public func beginWrite() async throws -> UUID {
        try Task.checkCancellation()
        guard state != .retired else { throw CancellationError() }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                if Task.isCancelled || state == .retired {
                    continuation.resume(throwing: CancellationError())
                } else if state == .paused {
                    admissions[id] = continuation
                } else {
                    activeWrites.insert(id)
                    continuation.resume(returning: id)
                }
            }
        } onCancel: {
            Task { await self.cancelAdmission(id) }
        }
    }

    /// Idempotent release, only after the accepted operation actually completes.
    public func finishWrite(_ id: UUID) {
        guard activeWrites.remove(id) != nil, activeWrites.isEmpty else { return }
        let pending = drains
        drains.removeAll()
        for continuation in pending { continuation.resume() }
    }

    /// Pause new admission before draining. Late server-receipt handlers wait here
    /// instead of writing old drafts into newly restored storage.
    public func suspendAndDrain() async {
        if state == .active { state = .paused }
        guard !activeWrites.isEmpty else { return }
        await withCheckedContinuation { drains.append($0) }
    }

    public func resumeAfterFailedRestore() {
        guard state == .paused else { return }
        state = .active
        let pending = admissions
        admissions.removeAll()
        for (id, continuation) in pending {
            activeWrites.insert(id)
            continuation.resume(returning: id)
        }
    }

    /// Successful restoration uses a fresh session. Original queued intent cannot
    /// acquire mutation authority over the restored storage.
    public func retireForReload() {
        state = .retired
        let pending = admissions.values
        admissions.removeAll()
        for continuation in pending { continuation.resume(throwing: CancellationError()) }
    }

    /// The host checks before and after a storage read. Retired graphs cannot
    /// publish a value from the restored storage through an old callback.
    public func checkRead() throws {
        try Task.checkCancellation()
        guard state == .active else { throw CancellationError() }
    }

    private func cancelAdmission(_ id: UUID) {
        admissions.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}
