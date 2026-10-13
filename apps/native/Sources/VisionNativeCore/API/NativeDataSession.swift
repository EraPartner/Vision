import Foundation

/// One native client's lifetime around the current database. A restore pauses admission
/// before switching databases, waits for real transport completions, and retires this
/// session after success. Cancellation never means that a server write was rolled back.
public actor NativeDataSession {
    private enum State { case active, paused, retired }
    private var state = State.active
    private var activeWrites: Set<UUID> = []
    private var admissions: [UUID: CheckedContinuation<UUID?, any Error>] = [:]
    private var drains: [CheckedContinuation<Void, Never>] = []

    public init() {}

    /// Settings writers must flush while the session is still active. Stop streams next,
    /// then call this fence before the database switch. Cancelling the caller does not
    /// shorten the drain: accepted writes may still have committed on the server.
    public func suspendAndDrain() async {
        if state == .active { state = .paused }
        guard !activeWrites.isEmpty else { return }
        await withCheckedContinuation { drains.append($0) }
    }

    /// A failed or cancelled restore keeps the original database and client alive.
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

    /// The successful restore's full reload creates a new session. Old models cannot
    /// admit requests or publish responses from requests admitted before retirement.
    public func retireForReload() {
        state = .retired
        let pending = admissions.values
        admissions.removeAll()
        for continuation in pending { continuation.resume(throwing: CancellationError()) }
    }

    fileprivate func admit(_ method: HTTPMethod) async throws -> UUID? {
        try checkUsable()
        guard Self.isMutation(method) else { return nil }
        let id = UUID()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                // This registration is synchronous on the actor. The cancellation
                // handler either removes a registered waiter or this check rejects it.
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

    fileprivate func checkUsable() throws {
        try Task.checkCancellation()
        guard state != .retired else { throw CancellationError() }
    }

    fileprivate func finished(_ admission: UUID?) {
        guard let admission, activeWrites.remove(admission) != nil, activeWrites.isEmpty else { return }
        let pending = drains
        drains.removeAll()
        for continuation in pending { continuation.resume() }
    }

    private func cancelAdmission(_ id: UUID) {
        admissions.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    private static func isMutation(_ method: HTTPMethod) -> Bool {
        switch method {
        case .post, .put, .patch, .delete: true
        case .get, .head, .options: false
        }
    }
}

/// Supply this same value as APIClient's normal and streaming transports. It leaves
/// URLSession's HTTP behavior unchanged and holds only the shared session admission.
/// The stream receiver stays outside the actor, preserving APIStreamTransport's
/// non-Sendable callback contract.
public struct NativeSessionAPITransport: APITransport, APIStreamTransport {
    private let base: any APITransport
    private let streamBase: any APIStreamTransport
    public let session: NativeDataSession

    public init(base: any APITransport, streamBase: any APIStreamTransport, session: NativeDataSession) {
        self.base = base
        self.streamBase = streamBase
        self.session = session
    }

    public func send(_ request: APIRequest) async throws -> APIResponse {
        let admission = try await session.admit(request.method)
        do {
            try await session.checkUsable()
            let response = try await base.send(request)
            await session.finished(admission)
            try await session.checkUsable()
            return response
        } catch {
            await session.finished(admission)
            try await session.checkUsable()
            throw error
        }
    }

    public func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        let admission = try await session.admit(request.method)
        do {
            try await session.checkUsable()
            let response = try await streamBase.stream(request) { chunk in
                try await session.checkUsable()
                try await receive(chunk)
            }
            await session.finished(admission)
            try await session.checkUsable()
            return response
        } catch {
            await session.finished(admission)
            try await session.checkUsable()
            throw error
        }
    }
}
