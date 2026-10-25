import Foundation
import Testing

@testable import VisionNativeCore

private actor LocalStateGate {
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

private actor LocalStateStore {
    struct Write: Equatable, Sendable {
        let dataset: String
        let value: String
    }
    private var dataset = "original"
    private(set) var writes: [Write] = []
    let entered = LocalStateGate()
    let completion = LocalStateGate()
    func write(_ value: String, holding: Bool) async {
        if holding {
            await entered.open()
            // An actual WK operation may finish after its caller is cancelled.
            await completion.wait()
        }
        writes.append(.init(dataset: dataset, value: value))
    }
    func restore() { dataset = "restored" }
}

@Suite struct NativeLocalStateSessionTests {
    private func eventually(_ predicate: () async -> Bool) async -> Bool {
        for _ in 0..<10_000 {
            if await predicate() { return true }
            await Task.yield()
        }
        return false
    }
    private func write(
        _ value: String, session: NativeLocalStateSession, store: LocalStateStore, holding: Bool = false
    ) async throws {
        let token = try await session.beginWrite()
        await store.write(value, holding: holding)
        await session.finishWrite(token)
        try Task.checkCancellation()
    }

    @Test func cancellationCannotShortenTheActualAcceptedWriteDrain() async throws {
        let session = NativeLocalStateSession()
        let store = LocalStateStore()
        let writer = Task { try await write("accepted", session: session, store: store, holding: true) }
        await store.entered.wait()
        let completed = LocalStateGate()
        let drain = Task {
            await session.suspendAndDrain()
            await completed.open()
        }
        #expect(await eventually { await session.isSuspended })
        writer.cancel()
        #expect(await session.activeWriteCount == 1)
        #expect(await completed.isOpen == false)
        await store.completion.open()
        await #expect(throws: CancellationError.self) { try await writer.value }
        await drain.value
        #expect(await store.writes == [.init(dataset: "original", value: "accepted")])
        #expect(await session.activeWriteCount == 0)
    }

    @Test func lateReceiptWaitsAndAFailedRestoreResumesTheSameStorage() async throws {
        let session = NativeLocalStateSession()
        let store = LocalStateStore()
        await session.suspendAndDrain()
        let lateReceipt = Task { try await write("late-draft", session: session, store: store) }
        #expect(await eventually { await session.pendingWriteCount == 1 })
        #expect(await store.writes.isEmpty)
        await session.resumeAfterFailedRestore()
        try await lateReceipt.value
        #expect(await store.writes == [.init(dataset: "original", value: "late-draft")])
        try await session.checkRead()
    }

    @Test func successfulRestoreRejectsOriginalIntentAndUsesANewSession() async throws {
        let old = NativeLocalStateSession()
        let store = LocalStateStore()
        await old.suspendAndDrain()
        let lateReceipt = Task { try await write("old-draft", session: old, store: store) }
        #expect(await eventually { await old.pendingWriteCount == 1 })
        await store.restore()
        #expect(await store.writes.isEmpty)
        await old.retireForReload()
        await #expect(throws: CancellationError.self) { try await lateReceipt.value }
        await #expect(throws: CancellationError.self) { _ = try await old.beginWrite() }
        await #expect(throws: CancellationError.self) { try await old.checkRead() }
        await old.resumeAfterFailedRestore()
        await #expect(throws: CancellationError.self) { _ = try await old.beginWrite() }
        try await write("fresh-draft", session: NativeLocalStateSession(), store: store)
        #expect(await store.writes == [.init(dataset: "restored", value: "fresh-draft")])
    }

    @Test func cancellationRemovesARegisteredWaiterExactlyOnce() async throws {
        let session = NativeLocalStateSession()
        await session.suspendAndDrain()
        let writer = Task { try await session.beginWrite() }
        #expect(await eventually { await session.pendingWriteCount == 1 })
        writer.cancel()
        await #expect(throws: CancellationError.self) { _ = try await writer.value }
        #expect(await session.pendingWriteCount == 0)
        await session.resumeAfterFailedRestore()
        #expect(await session.activeWriteCount == 0)
        let token = try await session.beginWrite()
        await session.finishWrite(token)
        await session.finishWrite(token)
        #expect(await session.activeWriteCount == 0)
    }

    @Test func cancelledAdmissionAndPausedReadsHaveNoStorageAuthority() async throws {
        let session = NativeLocalStateSession()
        let gate = LocalStateGate()
        let writer = Task {
            await gate.wait()
            return try await session.beginWrite()
        }
        writer.cancel()
        await gate.open()
        await #expect(throws: CancellationError.self) { _ = try await writer.value }
        #expect(await session.activeWriteCount == 0)
        #expect(await session.pendingWriteCount == 0)
        await session.suspendAndDrain()
        await #expect(throws: CancellationError.self) { try await session.checkRead() }
        await session.resumeAfterFailedRestore()
        try await session.checkRead()
    }
}
