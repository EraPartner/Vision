import Foundation
import Testing

@testable import VisionNativeCore

private actor NativeSessionGate {
    private(set) var isOpen = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    func wait() async {
        guard !isOpen else { return }
        await withCheckedContinuation { waiters.append($0) }
    }

    func open() {
        isOpen = true
        let pending = waiters
        waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }
}

private actor NativeSessionLedger {
    struct Entry: Sendable, Equatable {
        let method: HTTPMethod
        let path: String
        let dataset: String
    }

    private(set) var entries: [Entry] = []
    private var dataset = "original"
    private var arrivals: [String: [CheckedContinuation<Void, Never>]] = [:]
    let gate = NativeSessionGate()
    var failure = false

    func begin(_ request: APIRequest) -> Bool {
        entries.append(Entry(method: request.method, path: request.url.path, dataset: dataset))
        for waiter in arrivals.removeValue(forKey: request.url.path) ?? [] { waiter.resume() }
        return request.url.path.hasPrefix("/held")
    }

    func waitForRequest(_ path: String) async {
        guard !entries.contains(where: { $0.path == path }) else { return }
        await withCheckedContinuation { arrivals[path, default: []].append($0) }
    }

    func switchDataset() { dataset = "restored" }
    func fail() { failure = true }
}

private struct NativeSessionDelegateFailure: Error {}

/// Deliberately ignores cancellation while held: a cancelled client cannot assume
/// that an accepted write stopped executing or failed to commit on the server.
private struct NativeSessionTestTransport: APITransport, APIStreamTransport {
    let ledger: NativeSessionLedger

    func send(_ request: APIRequest) async throws -> APIResponse {
        if await ledger.begin(request) { await ledger.gate.wait() }
        if await ledger.failure { throw NativeSessionDelegateFailure() }
        return APIResponse(status: 200, body: Data("original-response".utf8))
    }

    func stream(_ request: APIRequest, receive: (Data) async throws -> Void) async throws -> APIResponse {
        if await ledger.begin(request) { await ledger.gate.wait() }
        try await receive(Data("data: synthetic\n\n".utf8))
        return APIResponse(status: 200, body: Data())
    }
}

@Suite struct NativeDataSessionTests {
    private func request(_ method: HTTPMethod, _ path: String = "/synthetic") -> APIRequest {
        APIRequest(
            method: method, url: URL(string: "http://127.0.0.1:1\(path)")!, headers: [:], body: nil, timeout: 30)
    }

    private func transport(_ session: NativeDataSession, _ ledger: NativeSessionLedger) -> NativeSessionAPITransport {
        let base = NativeSessionTestTransport(ledger: ledger)
        return NativeSessionAPITransport(base: base, streamBase: base, session: session)
    }

    private func eventually(_ predicate: () async -> Bool) async -> Bool {
        for _ in 0..<10_000 {
            if await predicate() { return true }
            await Task.yield()
        }
        return false
    }

    @Test func drainWaitsForActualDelegateCompletionEvenAfterWriteCancellation() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let write = Task { try await wrapper.send(request(.patch, "/held-write")) }
        await ledger.waitForRequest("/held-write")
        let drained = NativeSessionGate()
        let drain = Task {
            await session.suspendAndDrain()
            await drained.open()
        }
        #expect(await eventually { await session.isSuspended })
        write.cancel()
        #expect(await drained.isOpen == false)
        await ledger.gate.open()
        await #expect(throws: CancellationError.self) { _ = try await write.value }
        await drain.value
        #expect(await drained.isOpen)
        await session.resumeAfterFailedRestore()
        _ = try await wrapper.send(request(.post, "/after-drain"))
        #expect(await ledger.entries.map(\.path) == ["/held-write", "/after-drain"])
    }

    @Test func successfulRestoreRejectsQueuedAndFutureWritesAcrossTransportCopies() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let copy = wrapper
        await session.suspendAndDrain()
        let queued = Task { try await copy.send(request(.post, "/old-model-write")) }
        #expect(await eventually { await session.pendingMutationCount == 1 })
        await ledger.switchDataset()
        await session.retireForReload()
        await #expect(throws: CancellationError.self) { _ = try await queued.value }
        await #expect(throws: CancellationError.self) { _ = try await wrapper.send(request(.delete)) }
        await #expect(throws: CancellationError.self) { _ = try await copy.send(request(.put)) }
        await #expect(throws: CancellationError.self) { _ = try await copy.send(request(.get)) }
        #expect(await ledger.entries.isEmpty)
        #expect(await session.pendingMutationCount == 0)
        // Only a freshly constructed lifetime can reach the restored database.
        _ = try await transport(NativeDataSession(), ledger).send(request(.post, "/new-model-write"))
        #expect(await ledger.entries.map(\.dataset) == ["restored"])
    }

    @Test func failedRestoreResumesPausedMutationsInOriginalSession() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        await session.suspendAndDrain()
        let first = Task { try await wrapper.send(request(.post, "/first")) }
        let second = Task { try await wrapper.send(request(.put, "/second")) }
        #expect(await eventually { await session.pendingMutationCount == 2 })
        #expect(await ledger.entries.isEmpty)
        await session.resumeAfterFailedRestore()
        _ = try await first.value
        _ = try await second.value
        #expect(await ledger.entries.count == 2)
        #expect(await ledger.entries.allSatisfy { $0.dataset == "original" })
        #expect(await session.pendingMutationCount == 0)
    }

    @Test func cancellingPausedAdmissionRemovesWaiterWithoutSendingOrLeakingDrain() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        await session.suspendAndDrain()
        let queued = Task { try await wrapper.send(request(.patch)) }
        #expect(await eventually { await session.pendingMutationCount == 1 })
        queued.cancel()
        await #expect(throws: CancellationError.self) { _ = try await queued.value }
        #expect(await session.pendingMutationCount == 0)
        await session.resumeAfterFailedRestore()
        await session.suspendAndDrain()
        #expect(await ledger.entries.isEmpty)
    }

    @Test func cancellationBeforeAdmissionNeverReachesDelegate() async {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let start = NativeSessionGate()
        let queued = Task {
            await start.wait()
            return try await wrapper.send(request(.post))
        }
        queued.cancel()
        await start.open()
        await #expect(throws: CancellationError.self) { _ = try await queued.value }
        #expect(await ledger.entries.isEmpty)
        #expect(await session.pendingMutationCount == 0)
        await session.suspendAndDrain()
    }

    @Test func cancellationRacingWithResumeDoesNotSendOrRetainAnActiveWrite() async {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        await session.suspendAndDrain()
        let queued = Task { try await wrapper.send(request(.put)) }
        #expect(await eventually { await session.pendingMutationCount == 1 })
        // Resume may beat the cancellation handler's actor hop. The transport's
        // post-admission cancellation check must still release that accepted permit.
        queued.cancel()
        await session.resumeAfterFailedRestore()
        await #expect(throws: CancellationError.self) { _ = try await queued.value }
        await session.suspendAndDrain()
        #expect(await ledger.entries.isEmpty)
        #expect(await session.pendingMutationCount == 0)
    }

    @Test func pausedReadsCannotReachTemporaryDatasetAndRetiredReadsStayBlocked() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        await session.suspendAndDrain()
        await ledger.switchDataset()
        for method in [HTTPMethod.get, .head, .options] {
            await #expect(throws: CancellationError.self) { _ = try await wrapper.send(request(method)) }
        }
        #expect(await ledger.entries.isEmpty)
        await session.retireForReload()
        await #expect(throws: CancellationError.self) { _ = try await wrapper.send(request(.get)) }
        #expect(await ledger.entries.isEmpty)
    }

    @Test func readAdmittedBeforeRestoreCannotPublishAfterRollbackAndResume() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let read = Task { try await wrapper.send(request(.get, "/held-read")) }
        await ledger.waitForRequest("/held-read")
        await session.suspendAndDrain()
        await session.resumeAfterFailedRestore()
        await ledger.gate.open()
        await #expect(throws: CancellationError.self) { _ = try await read.value }
        #expect(try await wrapper.send(request(.get)).status == 200)
        #expect(await ledger.entries.count == 2)
    }

    @Test func readAdmittedBeforeRestoreCannotPublishAfterSuccessfulRetirement() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let read = Task { try await wrapper.send(request(.get, "/held-read")) }
        await ledger.waitForRequest("/held-read")
        await session.suspendAndDrain()
        await session.retireForReload()
        await ledger.gate.open()
        await #expect(throws: CancellationError.self) { _ = try await read.value }
        await #expect(throws: CancellationError.self) { _ = try await wrapper.send(request(.get)) }
        #expect(await ledger.entries.count == 1)
    }

    @Test func streamingPostUsesSameAdmissionAndDrainsUntilDelegateActuallyReturns() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let chunks = NativeSessionGate()
        let stream = Task {
            try await wrapper.stream(request(.post, "/held-stream")) { _ in await chunks.open() }
        }
        await ledger.waitForRequest("/held-stream")
        let drained = NativeSessionGate()
        let drain = Task {
            await session.suspendAndDrain()
            await drained.open()
        }
        #expect(await eventually { await session.isSuspended })
        #expect(await drained.isOpen == false)
        await ledger.gate.open()
        #expect(try await stream.value.status == 200)
        await drain.value
        #expect(await chunks.isOpen)
        await session.retireForReload()
        await #expect(throws: CancellationError.self) {
            _ = try await wrapper.stream(request(.post)) { _ in Issue.record("Retired stream delivered a chunk") }
        }
        #expect(await ledger.entries.count == 1)
    }

    @Test func retirementRejectsChunksFromAnAlreadyAdmittedReadStream() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let stream = Task {
            try await wrapper.stream(request(.get, "/held-stream")) { _ in
                Issue.record("Retired stream delivered a chunk")
            }
        }
        await ledger.waitForRequest("/held-stream")
        await session.retireForReload()
        await ledger.gate.open()
        await #expect(throws: CancellationError.self) { _ = try await stream.value }
    }

    @Test func readStreamCannotDeliverPreRestoreChunksAfterFailedResume() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let stream = Task {
            try await wrapper.stream(request(.get, "/held-stream")) { _ in
                Issue.record("Pre-restore stream delivered a chunk after rollback")
            }
        }
        await ledger.waitForRequest("/held-stream")
        await session.suspendAndDrain()
        await session.resumeAfterFailedRestore()
        await ledger.gate.open()
        await #expect(throws: CancellationError.self) { _ = try await stream.value }
    }

    @Test func delegateFailureAlsoReleasesDrainAndPreservesErrorWhileSessionLives() async throws {
        let session = NativeDataSession()
        let ledger = NativeSessionLedger()
        let wrapper = transport(session, ledger)
        let write = Task { try await wrapper.send(request(.delete, "/held-failure")) }
        await ledger.waitForRequest("/held-failure")
        let drain = Task { await session.suspendAndDrain() }
        #expect(await eventually { await session.isSuspended })
        await ledger.fail()
        await ledger.gate.open()
        await #expect(throws: NativeSessionDelegateFailure.self) { _ = try await write.value }
        await drain.value
        await session.retireForReload()
        await session.resumeAfterFailedRestore()
        await #expect(throws: CancellationError.self) { _ = try await wrapper.send(request(.post)) }
    }
}
