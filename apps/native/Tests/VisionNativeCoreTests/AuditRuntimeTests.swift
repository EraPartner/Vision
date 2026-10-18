import Foundation
import Testing
@testable import VisionNativeCore

// The audit half of the native runtime against a fake backend bridge.

/// The backend's `/api/internal/audit/<endpoint>`: answers are scripted per endpoint and
/// every request is recorded.
final class FakeAuditBackend: AuditBridgeTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var answers: [String: [JSONValue]] = [:]
    private var fallback: [String: JSONValue] = [:]
    private var recorded: [(String, JSONValue)] = []

    /// The next answer for `endpoint`; after the queue is used up, `always` answers.
    func answer(_ endpoint: String, _ value: JSONValue) {
        lock.withLock { answers[endpoint, default: []].append(value) }
    }

    func always(_ endpoint: String, _ value: JSONValue) {
        lock.withLock { fallback[endpoint] = value }
    }

    var requests: [(String, JSONValue)] { lock.withLock { recorded } }

    func endpoints() -> [String] { requests.map(\.0) }

    func send(_ endpoint: String, _ payload: JSONValue) async throws -> JSONValue {
        try lock.withLock {
            recorded.append((endpoint, payload))
            if var queue = answers[endpoint], !queue.isEmpty {
                let next = queue.removeFirst()
                answers[endpoint] = queue
                return next
            }
            if let value = fallback[endpoint] { return value }
            throw AuditBridgeError("Audit bridge rejected request")
        }
    }
}

final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    init(_ value: Bool) {
        self.value = value
    }

    var current: Bool { lock.withLock { value } }
    func set(_ next: Bool) { lock.withLock { value = next } }
}

private let zeroCounts = JSONValue.object(["db_editor": .string("0"), "split": .string("0"), "retag": .string("0")])

private func unanchored(_ sequence: Int, _ label: String? = nil) -> JSONValue {
    .object([
        "status": .string("unavailable"), "sequence": .int(sequence),
        "hash": .string(auditHash(label ?? "head \(sequence)")), "legacyCutover": auditCutover,
        "legacyUnverified": zeroCounts,
    ])
}

private func verified(_ status: String, _ sequence: Int, _ label: String? = nil) -> JSONValue {
    .object([
        "status": .string(status), "sequence": .int(sequence), "hash": .string(auditHash(label ?? "head \(sequence)")),
        "legacyCutover": auditCutover,
    ])
}

private struct RuntimeFixture {
    let anchorFixture: AnchorFixture
    let backend: FakeAuditBackend
    let newCluster: Flag
    let runtime: AuditRuntime

    init(newCluster: Bool = true, now: @escaping @Sendable () -> Date = { Date() }) throws {
        let anchorFixture = try AnchorFixture()
        let flag = Flag(newCluster)
        let backend = FakeAuditBackend()
        self.backend = backend
        self.anchorFixture = anchorFixture
        self.newCluster = flag
        runtime = AuditRuntime(
            anchor: anchorFixture.anchor, transport: backend, newClusterCreatedThisLaunch: { flag.current }, now: now)
    }

    var anchor: AuditAnchor { anchorFixture.anchor }

    func remove() { anchorFixture.remove() }
}

@Suite struct AuditRuntimeTests {
    @Test func withoutABridgeOrAnchorProtectionIsUnavailable() async throws {
        let runtime = AuditRuntime(anchor: nil, transport: nil, newClusterCreatedThisLaunch: { true })
        let result = try await runtime.verifyAuditHistory(establishSession: true)
        #expect(result == .object(["status": .string("unavailable"), "reason": .string("bridge_or_anchor_unavailable")]))
        let pending = await runtime.sessionPending
        #expect(!pending)
        let page = try await runtime.readVerifiedAuditEntries()
        #expect(page["verification"]?["reason"] == .string("bridge_or_anchor_unavailable"))
        #expect(page["entries"] == .array([]))
    }

    @Test func aNewClusterAnchorsItsFirstCheckpoint() async throws {
        let fixture = try RuntimeFixture()
        defer { fixture.remove() }
        fixture.backend.answer("verify", unanchored(4))
        fixture.backend.always("checkpoint", .object(["recorded": .bool(true)]))
        let result = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(result == .object(["status": .string("verified"), "sequence": .int(4), "hash": .string(auditHash("head 4"))]))
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.sequence == 4)
        #expect(trusted.metadata.enrollmentSequence == nil)
        let requests = fixture.backend.requests
        #expect(requests.map(\.0) == ["verify", "checkpoint"])
        #expect(requests[0].1 == .object([:]))
        #expect(requests[1].1 == trusted.metadata.bridgePayload)
        let enabled = await fixture.runtime.closureEnabled
        #expect(enabled)
    }

    @Test func anExistingClusterWithoutAnAnchorNeedsEnrollment() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        fixture.backend.answer("verify", unanchored(4))
        let result = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(result == .object(["status": .string("unavailable"), "reason": .string("no_trusted_anchor")]))
        await expectAnchorError("uninitialized") { _ = try await fixture.anchor.readTrustedCheckpoint() }

        // Explicit enrollment signs the current head as the baseline.
        fixture.backend.answer("verify", unanchored(4))
        fixture.backend.answer("verify", verified("verified", 4))
        fixture.backend.always("checkpoint", .object([:]))
        let enrolled = try await fixture.runtime.enrollExistingAuditHistory()
        #expect(enrolled == .object(["status": .string("verified"), "enrollmentSequence": .int(4)]))
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.metadata.enrollmentSequence == 4)
        let again = try await fixture.runtime.enrollExistingAuditHistory()
        #expect(again == .object(["status": .string("unavailable"), "reason": .string("already_enrolled")]))
    }

    @Test func aTrustedAnchorIsSentForVerification() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(4), legacyCutover: auditCutover)
        fixture.backend.answer("verify", verified("verified", 4))
        fixture.backend.always("checkpoint", .object([:]))
        let result = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(result["status"] == .string("verified"))
        let requests = fixture.backend.requests
        #expect(requests.map(\.0) == ["verify", "checkpoint"])
        #expect(
            requests[0].1
                == .object(["trustedCheckpoint": .object(["sequence": .int(4), "hash": .string(auditHash("head 4"))])]))

        fixture.backend.answer("verify", .object(["status": .string("unavailable")]))
        let missing = try await fixture.runtime.verifyAuditHistory()
        #expect(missing == .object(["status": .string("failed"), "reason": .string("anchored_history_unavailable")]))

        var changed = verified("verified", 4).objectValue ?? [:]
        changed["legacyCutover"] = .object(["dbEditorMaxId": .int(4), "splitMaxId": .int(1), "retagMaxId": .int(0)])
        fixture.backend.answer("verify", .object(changed))
        let cutover = try await fixture.runtime.verifyAuditHistory()
        #expect(cutover == .object(["status": .string("failed"), "reason": .string("legacy_cutover_changed")]))
    }

    @Test func theLiveClosureAnchorsAVerifiedTail() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(4), legacyCutover: auditCutover)
        fixture.backend.answer("verify", verified("verified", 4))
        fixture.backend.always("checkpoint", .object([:]))
        _ = try await fixture.runtime.verifyAuditHistory(establishSession: true)

        fixture.backend.answer("verify", verified("partially_verified", 9))
        let closed = try await fixture.runtime.closeAuditCheckpoint()
        #expect(closed["status"] == .string("verified"))
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.sequence == 9)

        // A restore pauses the closure.
        await fixture.runtime.pauseAuditClosure()
        let paused = try await fixture.runtime.closeAuditCheckpoint()
        #expect(paused == .object(["status": .string("unavailable"), "reason": .string("live_closure_not_active")]))
        await fixture.runtime.resumeAuditClosure()

        // A failed verification turns the closure off.
        fixture.backend.answer("verify", .object(["status": .string("failed"), "reason": .string("hash_mismatch")]))
        let failed = try await fixture.runtime.closeAuditCheckpoint()
        #expect(failed["status"] == .string("failed"))
        let enabled = await fixture.runtime.closureEnabled
        #expect(!enabled)
    }

    /// native.test.ts: an ended session (a lost backend or a failed closure) must be
    /// established again at the exact trusted checkpoint; an unanchored tail cannot.
    @Test func anEndedSessionMustBeEstablishedAgainAtTheTrustedCheckpoint() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(4), legacyCutover: auditCutover)
        fixture.backend.always("checkpoint", .object([:]))
        fixture.backend.answer("verify", verified("verified", 4))
        _ = try await fixture.runtime.verifyAuditHistory(establishSession: true)

        await fixture.runtime.endAuditSession()
        let pendingAfterEnd = await fixture.runtime.sessionPending
        #expect(pendingAfterEnd)
        fixture.backend.answer("verify", verified("verified", 4))
        let reestablished = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(reestablished["status"] == .string("verified"))
        let enabledAfterEstablish = await fixture.runtime.closureEnabled
        #expect(enabledAfterEstablish)

        // A temporary bridge failure during the closure ends the session.
        await #expect(throws: (any Error).self) { try await fixture.runtime.closeAuditCheckpoint() }
        let enabledAfterFailure = await fixture.runtime.closureEnabled
        #expect(!enabledAfterFailure)
        let pendingAfterFailure = await fixture.runtime.sessionPending
        #expect(pendingAfterFailure)
        fixture.backend.answer("verify", verified("verified", 4))
        let recovered = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(recovered["status"] == .string("verified"))
        let enabledAfterRecovery = await fixture.runtime.closureEnabled
        #expect(enabledAfterRecovery)

        // Writes after the session ended stay unanchored and never start a new session.
        await fixture.runtime.endAuditSession()
        let inactive = try await fixture.runtime.closeAuditCheckpoint()
        #expect(inactive["reason"] == .string("live_closure_not_active"))
        fixture.backend.answer("verify", verified("partially_verified", 6))
        let partial = try await fixture.runtime.verifyAuditHistory(establishSession: true)
        #expect(partial["status"] == .string("partially_verified"))
        let enabledForTail = await fixture.runtime.closureEnabled
        #expect(!enabledForTail)
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.sequence == 4)
    }

    @Test func aRestoredHistoryMustVerifyAgainstTheAnchor() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(4), legacyCutover: auditCutover)

        fixture.backend.answer("verify", verified("verified", 4))
        let accepted = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: false)
        #expect(accepted["status"] == .string("verified"))

        fixture.backend.answer("verify", .object(["status": .string("failed"), "reason": .string("hash_mismatch")]))
        do {
            _ = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: false)
            Issue.record("a failed history must be refused")
        } catch let error as AuditRestoreError {
            #expect(error.code == "RESTORED_AUDIT_INTEGRITY_FAILED")
            #expect(error.auditStatus == "failed")
            #expect(error.auditReason == "hash_mismatch")
        }

        fixture.backend.answer("verify", verified("partially_verified", 6))
        do {
            _ = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: false)
            Issue.record("a partially verified history must be refused")
        } catch let error as AuditRestoreError {
            #expect(error.code == "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE")
            #expect(error.auditStatus == "partially_verified")
        }

        // Without a backend answer the bridge is unavailable.
        do {
            _ = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: false)
            Issue.record("an unreachable bridge must be refused")
        } catch let error as AuditRestoreError {
            #expect(error.code == "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE")
            #expect(error.auditReason == "bridge_unavailable")
        }

        // The explicit recovery accepts an internally consistent chain and ends the session.
        fixture.backend.answer("verify", unanchored(2))
        let recovered = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: true)
        #expect(recovered == .object(["status": .string("unavailable"), "reason": .string("explicit_recovery")]))
        fixture.backend.answer("verify", .object(["status": .string("failed")]))
        do {
            _ = try await fixture.runtime.assertRestoredAuditHistory(allowUnverifiedAudit: true)
            Issue.record("an invalid chain must be refused even in recovery")
        } catch let error as AuditRestoreError {
            #expect(error.code == "RESTORED_AUDIT_RECOVERY_INVALID")
        }
    }

    @Test func retentionSignsTheBoundaryThenPrunes() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(12), legacyCutover: auditCutover)
        fixture.backend.answer("verify", verified("verified", 12))
        fixture.backend.always("checkpoint", .object([:]))
        _ = try await fixture.runtime.verifyAuditHistory(establishSession: true)

        var plan = auditRetention(through: 4).objectValue ?? [:]
        plan["eligible"] = .bool(true)
        fixture.backend.answer("retention-plan", .object(plan))
        fixture.backend.answer("retention-prune", .object(["removed": .int(4)]))
        let result = try await fixture.runtime.runAuditRetentionIfDue()
        #expect(result == .object(["status": .string("pruned"), "removed": .int(4)]))
        let trusted = try await fixture.anchor.readTrustedCheckpoint()
        #expect(trusted.retention?.through == 4)
        #expect(Array(fixture.backend.endpoints().suffix(3)) == ["retention-plan", "checkpoint", "retention-prune"])
        let prune = try #require(fixture.backend.requests.last)
        #expect(prune.1["trustedCheckpoint"]?["retention"]?["through"] == .int(4))

        let notDue = try await fixture.runtime.runAuditRetentionIfDue()
        #expect(notDue == .object(["status": .string("not_due")]))
    }

    @Test func aVerifiedPageIsCheckedAgainstTheAnchor() async throws {
        let fixture = try RuntimeFixture(newCluster: false)
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(
            head: auditHead(2), legacyCutover: auditCutover, enrollment: true)
        let verification = JSONValue.object([
            "status": .string("partially_verified"), "anchoredThrough": .int(2), "sequence": .int(3),
            "legacyCutover": auditCutover,
        ])
        func entry(_ sequence: Int, _ status: String) -> JSONValue {
            .object(["sequence": .int(sequence), "anchorStatus": .string(status)])
        }
        fixture.backend.answer(
            "read",
            .object([
                "verification": verification, "entries": .array([entry(1, "anchored"), entry(3, "pending_anchor")]),
                "hasMore": .bool(false),
            ]))
        let page = try await fixture.runtime.readVerifiedAuditEntries(afterSequence: 0, limit: 50)
        #expect(page["entries"]?.arrayValue?.count == 2)
        #expect(page["verification"]?["enrollmentSequence"] == .int(2))
        let request = try #require(fixture.backend.requests.last)
        #expect(request.1["afterSequence"] == .int(0))
        #expect(request.1["limit"] == .int(50))

        fixture.backend.answer(
            "read",
            .object([
                "verification": verification, "entries": .array([entry(3, "anchored")]), "hasMore": .bool(false),
            ]))
        let wrong = try await fixture.runtime.readVerifiedAuditEntries()
        #expect(wrong["verification"] == .object(["status": .string("failed"), "reason": .string("invalid_audit_read_response")]))
    }
}

@Suite struct AuditBridgeTests {
    @Test func onlyAnOkEnvelopeIsAccepted() throws {
        let ok = Data(#"{"ok":true,"data":{"status":"verified"}}"#.utf8)
        #expect(try URLSessionAuditBridge.unwrap(status: 200, body: ok) == .object(["status": .string("verified")]))
        #expect(throws: AuditBridgeError.self) { try URLSessionAuditBridge.unwrap(status: 401, body: ok) }
        #expect(throws: AuditBridgeError.self) {
            try URLSessionAuditBridge.unwrap(status: 200, body: Data(#"{"ok":false,"data":{}}"#.utf8))
        }
        #expect(throws: AuditBridgeError.self) {
            try URLSessionAuditBridge.unwrap(status: 200, body: Data(#"{"ok":true,"data":null}"#.utf8))
        }
        #expect(URLSessionAuditBridge.maximumResponseBytes("read") == 4 * 1024 * 1024)
        #expect(URLSessionAuditBridge.maximumResponseBytes("verify") == 16_384)
    }
}

@Suite struct AuditViewerTests {
    @Test func readOptionsFollowTheViewerContract() throws {
        #expect(try AuditViewer.validateReadOptions(nil) == AuditViewer.ReadRange(afterSequence: 0, limit: 100))
        #expect(
            try AuditViewer.validateReadOptions(.object(["afterSequence": .int(10), "limit": .int(1)]))
                == AuditViewer.ReadRange(afterSequence: 10, limit: 1))
        #expect(throws: AuditViewer.ViewerError("Invalid audit read options")) {
            try AuditViewer.validateReadOptions(.object(["page": .int(1)]))
        }
        #expect(throws: AuditViewer.ViewerError("Invalid audit read range")) {
            try AuditViewer.validateReadOptions(.object(["limit": .int(0)]))
        }
        #expect(throws: AuditViewer.ViewerError("Invalid audit read range")) {
            try AuditViewer.validateReadOptions(.object(["afterSequence": .double(1.5)]))
        }
    }
}
