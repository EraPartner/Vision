import Foundation

/// The audit hooks a restore drives (`pauseAuditClosure`, `resumeAuditClosure`,
/// `assertRestoredAuditHistory` and `endAuditSession` of the Electron native runtime).
public protocol AuditRestoreGuard: Sendable {
    func pauseAuditClosure() async
    func resumeAuditClosure() async
    /// Throws `AuditRestoreError` when the restored history does not verify against the
    /// trusted checkpoint (or, with `allowUnverifiedAudit`, when it is not even internally
    /// consistent).
    func assertRestoredAuditHistory(allowUnverifiedAudit: Bool) async throws -> JSONValue
    func endAuditSession() async
}

/// A restore whose audit history failed verification (`RESTORED_AUDIT_*`), with the
/// `auditStatus` and `auditReason` Electron attaches to the error.
public struct AuditRestoreError: Error, Equatable, Sendable, LocalizedError {
    public let code: String
    public let message: String
    public var auditStatus: String?
    public var auditReason: String?
    /// Set when the rollback after the failure itself failed (`auditRecoveryUnsafe`);
    /// the explicit recovery is then not offered.
    public var recoveryUnsafe: Bool

    public init(
        code: String, message: String, auditStatus: String? = nil, auditReason: String? = nil,
        recoveryUnsafe: Bool = false
    ) {
        self.code = code
        self.message = message
        self.auditStatus = auditStatus
        self.auditReason = auditReason
        self.recoveryUnsafe = recoveryUnsafe
    }

    public var errorDescription: String? { message }

    /// `AUDIT_RECOVERY_CODES`: failures the explicit recovery may override.
    public static let recoveryCodes: Set<String> = [
        "RESTORED_AUDIT_INTEGRITY_FAILED", "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
    ]
}

/// The audit half of `createNativeRuntime` in `packaging/electron/runtime/native.ts`:
/// verification against the trusted checkpoint, first-checkpoint initialization on a new
/// cluster, explicit enrollment, verified reads, the live closure, retention, transfer,
/// key rotation and the restore checks. Results are the bridge's untyped records, read
/// field by field as Electron does.
public actor AuditRuntime: AuditRestoreGuard {
    static let verifiedStatuses: Set<String> = ["verified", "partially_verified"]

    private let anchor: AuditAnchor?
    private let transport: (any AuditBridgeTransport)?
    private let newClusterCreatedThisLaunch: @Sendable () async -> Bool
    private let now: @Sendable () -> Date

    private var freshAuditReceiptId: String?
    private var sessionEstablished = false
    private var liveClosureEnabled = false
    private var anchorDetectedThisLaunch = false
    private var everTrustedThisLaunch = false
    private var checkpointMetadataSyncedThisLaunch = false
    private var closurePaused = false
    private var closureTail: Task<Void, Never>?
    private var lastRetentionAttempt = Date.distantPast
    private var retentionTask: Task<JSONValue, Error>?

    /// `transport` is `nil` without a bridge token and `anchor` is `nil` without key
    /// protection or a witness; audit protection is then unavailable.
    public init(
        anchor: AuditAnchor?, transport: (any AuditBridgeTransport)?,
        newClusterCreatedThisLaunch: @escaping @Sendable () async -> Bool,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.anchor = anchor
        self.transport = transport
        self.newClusterCreatedThisLaunch = newClusterCreatedThisLaunch
        self.now = now
    }

    // MARK: - Helpers

    private static func outcome(_ status: String, _ reason: String) -> JSONValue {
        .object(["status": .string(status), "reason": .string(reason)])
    }

    private static func isVerified(_ value: JSONValue?) -> Bool {
        value?.stringValue.map { verifiedStatuses.contains($0) } ?? false
    }

    /// `sendAuditRequest`.
    private func send(_ endpoint: String, _ payload: JSONValue) async throws -> JSONValue {
        guard let transport else {
            throw NativeRuntimeError("AUDIT_BRIDGE_UNAVAILABLE", "Native audit bridge is not configured")
        }
        return try await transport.send(endpoint, payload)
    }

    private var isConfigured: Bool { anchor != nil && transport != nil }

    /// `fieldsOf(value)`: `null` throws like reading a property of `null`.
    private static func requireValue(_ value: JSONValue) throws -> JSONValue {
        if value == .null { throw AuditInputError("Cannot read properties of null") }
        return value
    }

    private static func legacyCutoverMatches(_ candidate: JSONValue?, _ trusted: AuditLegacyCutover, strict: Bool)
        -> Bool
    {
        AuditLegacyCutover.fieldNames.allSatisfy { field in
            let value = candidate?[field]
            if strict, AuditJSON.safeInteger(value) == nil { return false }
            return value?.intValue == trusted.value(field)
        }
    }

    /// `Object.values(value)` for the `legacyUnverified` counts.
    private static func values(_ value: JSONValue) -> [JSONValue] {
        switch value {
        case .object(let fields): return Array(fields.values)
        case .array(let items): return items
        case .string(let text): return text.map { .string(String($0)) }
        default: return []
        }
    }

    // MARK: - Verification

    /// `verifyAuditHistory`.
    public func verifyAuditHistory(forRestore: Bool = false, establishSession: Bool = false) async throws
        -> JSONValue
    {
        let establishing = establishSession && !sessionEstablished
        func finish(_ result: JSONValue) -> JSONValue {
            if establishing { sessionEstablished = true }
            return result
        }
        guard let anchor, isConfigured else {
            return finish(Self.outcome("unavailable", "bridge_or_anchor_unavailable"))
        }
        var trusted: AuditTrustedCheckpoint?
        do {
            trusted = try await anchor.readTrustedCheckpoint()
            anchorDetectedThisLaunch = true
        } catch let error as AuditAnchorError where error.code == "uninitialized" {
            trusted = nil
        } catch {
            anchorDetectedThisLaunch = true
            return finish(Self.outcome("failed", "anchor_invalid"))
        }
        let result = try Self.requireValue(
            try await send(
                "verify", trusted.map { .object(["trustedCheckpoint": $0.bridgePayload]) } ?? .object([:])))
        let status = result["status"]?.stringValue
        if trusted != nil, status == "unavailable" {
            return finish(Self.outcome("failed", "anchored_history_unavailable"))
        }
        if status == "failed" { return finish(result) }
        if let trusted, !Self.legacyCutoverMatches(result["legacyCutover"], trusted.legacyCutover, strict: true) {
            return finish(Self.outcome("failed", "legacy_cutover_changed"))
        }
        guard let trusted else {
            let newCluster = await newClusterCreatedThisLaunch()
            guard !forRestore, newCluster, status == "unavailable",
                let sequence = AuditJSON.safeInteger(result["sequence"]), sequence >= 0,
                AuditJSON.isHash(result["hash"]), let unverified = result["legacyUnverified"], unverified.isTruthy,
                Self.values(unverified).allSatisfy({ $0 == .string("0") })
            else {
                return finish(Self.outcome("unavailable", "no_trusted_anchor"))
            }
            let metadata: AuditAnchorMetadata
            do {
                metadata = try await anchor.initializeFirstCheckpoint(
                    head: .object(["sequence": result["sequence"] ?? .null, "hash": result["hash"] ?? .null]),
                    legacyCutover: result["legacyCutover"])
            } catch let error as AuditAnchorError {
                return finish(Self.outcome("unavailable", error.code))
            }
            _ = try await send("checkpoint", metadata.bridgePayload)
            checkpointMetadataSyncedThisLaunch = true
            anchorDetectedThisLaunch = true
            everTrustedThisLaunch = true
            freshAuditReceiptId = metadata.receiptId
            if establishing { liveClosureEnabled = true }
            return finish(
                .object([
                    "status": .string("verified"), "sequence": result["sequence"] ?? .null,
                    "hash": result["hash"] ?? .null,
                ]))
        }
        guard let status, Self.verifiedStatuses.contains(status) else {
            return finish(Self.outcome("failed", "unexpected_verification_status"))
        }
        if establishing && !forRestore && !checkpointMetadataSyncedThisLaunch {
            do {
                _ = try await send("checkpoint", trusted.metadata.bridgePayload)
                checkpointMetadataSyncedThisLaunch = true
            } catch {
                return finish(Self.outcome("failed", "checkpoint_metadata_unavailable"))
            }
        }
        // A valid prefix does not make the unanchored tail independently trusted. Never
        // promote it to the external anchor during a later startup or restore.
        if establishing && status == "verified" {
            liveClosureEnabled = true
            everTrustedThisLaunch = true
        }
        return finish(result)
    }

    /// `enrollExistingAuditHistory`: the operator accepts this internally consistent
    /// history as the starting point; nothing before it can be attested.
    public func enrollExistingAuditHistory() async throws -> JSONValue {
        guard let anchor, isConfigured else { return Self.outcome("unavailable", "bridge_or_anchor_unavailable") }
        do {
            _ = try await anchor.readTrustedCheckpoint()
            return Self.outcome("unavailable", "already_enrolled")
        } catch let error as AuditAnchorError where error.code == "uninitialized" {
        } catch {
            return Self.outcome("failed", "anchor_invalid")
        }
        let result = try await send("verify", .object([:]))
        guard result["status"]?.stringValue == "unavailable", let sequence = AuditJSON.safeInteger(result["sequence"]),
            sequence >= 0, AuditJSON.isHash(result["hash"]), let cutover = result["legacyCutover"], cutover.isTruthy
        else {
            return Self.outcome("failed", "history_invalid")
        }
        let metadata: AuditAnchorMetadata
        do {
            metadata = try await anchor.initializeFirstCheckpoint(
                head: .object(["sequence": .int(sequence), "hash": result["hash"] ?? .null]), legacyCutover: cutover,
                enrollment: true)
            _ = try await send("checkpoint", metadata.bridgePayload)
            checkpointMetadataSyncedThisLaunch = true
        } catch {
            return Self.outcome("failed", "enrollment_incomplete")
        }
        anchorDetectedThisLaunch = true
        let verified = try await verifyAuditHistory(establishSession: true)
        guard Self.isVerified(verified["status"]) else {
            return Self.outcome("failed", "enrollment_verification_failed")
        }
        liveClosureEnabled = true
        everTrustedThisLaunch = true
        var fields: [String: JSONValue] = ["status": verified["status"] ?? .null]
        if let enrollment = metadata.enrollmentSequence { fields["enrollmentSequence"] = .int(enrollment) }
        return .object(fields)
    }

    /// `readVerifiedAuditEntries`: one verified page of the history.
    public func readVerifiedAuditEntries(afterSequence: Int = 0, limit: Int = 100) async throws -> JSONValue {
        guard afterSequence >= 0, afterSequence <= 9_007_199_254_740_991, (1...500).contains(limit) else {
            throw AuditInputError("Invalid audit read page")
        }
        func unavailable(_ status: String, _ reason: String) -> JSONValue {
            .object(["verification": Self.outcome(status, reason), "entries": .array([]), "hasMore": .bool(false)])
        }
        guard let anchor, isConfigured else { return unavailable("unavailable", "bridge_or_anchor_unavailable") }
        let trusted: AuditTrustedCheckpoint
        do {
            trusted = try await anchor.readTrustedCheckpoint()
        } catch let error as AuditAnchorError where error.code == "uninitialized" {
            return unavailable("unavailable", "no_trusted_anchor")
        } catch {
            return unavailable("failed", "anchor_invalid")
        }
        let result = try await send(
            "read",
            .object([
                "trustedCheckpoint": trusted.bridgePayload, "afterSequence": .int(afterSequence), "limit": .int(limit),
            ]))
        guard let verification = result["verification"], verification.isTruthy else {
            return unavailable("failed", "audit_read_verification_failed")
        }
        let retentionThrough = verification["retentionThrough"]
        let retentionMatches =
            trusted.retention.map { retentionThrough?.intValue == $0.through && retentionThrough != nil }
            ?? (retentionThrough == nil)
        guard Self.isVerified(verification["status"]), verification["anchoredThrough"]?.intValue == trusted.sequence,
            retentionMatches, Self.legacyCutoverMatches(verification["legacyCutover"], trusted.legacyCutover, strict: false)
        else {
            return unavailable("failed", "audit_read_verification_failed")
        }
        guard let entries = result["entries"]?.arrayValue, entries.count <= limit,
            let hasMore = result["hasMore"]?.boolValue
        else {
            return unavailable("failed", "invalid_audit_read_response")
        }
        let floor = max(afterSequence, trusted.retention?.through ?? 0)
        let verifiedHead = verification["sequence"]?.numberCoercion
        for entry in entries {
            let fields = try Self.requireValue(entry)
            guard let sequence = AuditJSON.safeInteger(fields["sequence"]) else {
                return unavailable("failed", "invalid_audit_read_response")
            }
            var beyondHead = false
            if let verifiedHead { beyondHead = Double(sequence) > verifiedHead }
            let expectedStatus = sequence <= trusted.sequence ? "anchored" : "pending_anchor"
            if sequence <= floor || beyondHead || fields["anchorStatus"]?.stringValue != expectedStatus {
                return unavailable("failed", "invalid_audit_read_response")
            }
        }
        var output = result.objectValue ?? [:]
        output["entries"] = .array(entries)
        output["hasMore"] = .bool(hasMore)
        var verified = verification.objectValue ?? [:]
        if let enrollment = trusted.metadata.enrollmentSequence { verified["enrollmentSequence"] = .int(enrollment) }
        output["verification"] = .object(verified)
        return .object(output)
    }

    // MARK: - Transfer and rotation

    /// `exportProtectedAuditTransfer`: only for a fully verified history, closed first.
    public func exportProtectedAuditTransfer(password: String) async throws -> Data {
        guard let anchor else { throw AuditAnchorError("uninitialized") }
        let verified = try await verifyAuditHistory()
        guard Self.isVerified(verified["status"]) else { throw AuditAnchorError("history_unverified") }
        if verified["status"]?.stringValue == "partially_verified" {
            let closed = try await closeAuditCheckpoint()
            guard closed["status"]?.stringValue == "verified" else { throw AuditAnchorError("history_unverified") }
        }
        return try await anchor.exportProtectedTransfer(password: password)
    }

    /// `importProtectedAuditTransfer`: only onto the fresh checkpoint this launch created
    /// on a new cluster.
    public func importProtectedAuditTransfer(_ contents: Data, password: String) async throws -> AuditCheckpoint {
        let newCluster = await newClusterCreatedThisLaunch()
        guard let anchor, newCluster, let fresh = freshAuditReceiptId else {
            throw AuditAnchorError("transfer_target_not_fresh")
        }
        await pauseAuditClosure()
        do {
            let current = try await anchor.readTrustedCheckpoint()
            guard current.metadata.receiptId == fresh,
                try await verifyAuditHistory()["status"]?.stringValue == "verified"
            else {
                throw AuditAnchorError("transfer_target_not_fresh")
            }
            let metadata = try await anchor.importProtectedTransfer(
                contents, password: password,
                expectedCurrent: AuditCheckpoint(sequence: current.sequence, hash: current.hash))
            freshAuditReceiptId = nil
            endAuditSession()
            checkpointMetadataSyncedThisLaunch = false
            resumeAuditClosure()
            return AuditCheckpoint(sequence: metadata.sequence, hash: metadata.headHash)
        } catch {
            resumeAuditClosure()
            throw error
        }
    }

    /// `rotateAuditKey`: only for a fully verified history, closed first.
    public func rotateAuditKey() async throws -> Int {
        guard let anchor else { throw AuditAnchorError("uninitialized") }
        let verified = try await verifyAuditHistory()
        guard Self.isVerified(verified["status"]) else { throw AuditAnchorError("history_unverified") }
        if verified["status"]?.stringValue == "partially_verified" {
            let closed = try await closeAuditCheckpoint()
            guard closed["status"]?.stringValue == "verified" else { throw AuditAnchorError("history_unverified") }
        }
        let metadata = try await anchor.rotateKey()
        freshAuditReceiptId = nil
        checkpointMetadataSyncedThisLaunch = false
        _ = try await send("checkpoint", metadata.bridgePayload)
        checkpointMetadataSyncedThisLaunch = true
        return metadata.sequence
    }

    // MARK: - Retention

    /// `runAuditRetentionIfDue`: at most once a day (five minutes after a failure), while
    /// the live closure is enabled.
    public func runAuditRetentionIfDue() async throws -> JSONValue {
        guard anchor != nil, transport != nil, liveClosureEnabled else {
            return .object(["status": .string("unavailable")])
        }
        if let retentionTask { return try await retentionTask.value }
        let day: TimeInterval = 24 * 60 * 60
        if now().timeIntervalSince(lastRetentionAttempt) < day { return .object(["status": .string("not_due")]) }
        lastRetentionAttempt = now()
        let task = Task { [self] in try await self.performRetention() }
        retentionTask = task
        do {
            let result = try await task.value
            retentionTask = nil
            return result
        } catch {
            lastRetentionAttempt = now().addingTimeInterval(-day + 5 * 60)
            retentionTask = nil
            throw error
        }
    }

    private func performRetention() async throws -> JSONValue {
        guard let anchor else { throw AuditAnchorError("uninitialized") }
        var trusted = try await anchor.readTrustedCheckpoint()
        if trusted.retention != nil {
            _ = try await send("retention-prune", .object(["trustedCheckpoint": trusted.bridgePayload]))
        }
        let plan = try await send("retention-plan", .object(["trustedCheckpoint": trusted.bridgePayload]))
        guard plan["eligible"]?.isTruthy == true else { return .object(["status": .string("nothing_due")]) }
        let metadata = try await anchor.persistRetentionBoundary(plan)
        checkpointMetadataSyncedThisLaunch = false
        _ = try await send("checkpoint", metadata.bridgePayload)
        checkpointMetadataSyncedThisLaunch = true
        trusted = try await anchor.readTrustedCheckpoint()
        let pruned = try await send("retention-prune", .object(["trustedCheckpoint": trusted.bridgePayload]))
        var fields: [String: JSONValue] = ["status": .string("pruned")]
        if let removed = pruned["removed"] { fields["removed"] = removed }
        return .object(fields)
    }

    // MARK: - Live closure

    /// `auditClosureEnabled`.
    public var closureEnabled: Bool { liveClosureEnabled }

    /// `auditSessionPending`.
    public var sessionPending: Bool { !sessionEstablished }

    /// `endAuditSession`.
    public func endAuditSession() {
        liveClosureEnabled = false
    }

    /// `pauseAuditClosure`: no closure starts, and the running one is awaited.
    public func pauseAuditClosure() async {
        closurePaused = true
        await closureTail?.value
    }

    /// `resumeAuditClosure`.
    public func resumeAuditClosure() {
        closurePaused = false
    }

    /// `closeAuditCheckpoint`: anchors a verified unanchored tail. Closures run one at a
    /// time; a failure disables the live closure.
    public func closeAuditCheckpoint() async throws -> JSONValue {
        let previous = closureTail
        let task = Task<JSONValue, Error> { [self] in
            await previous?.value
            return try await self.performClosure()
        }
        closureTail = Task { _ = try? await task.value }
        return try await task.value
    }

    private func performClosure() async throws -> JSONValue {
        if !liveClosureEnabled || closurePaused { return Self.outcome("unavailable", "live_closure_not_active") }
        do {
            let result = try await verifyAuditHistory()
            let status = result["status"]?.stringValue
            if status == "verified" { return result }
            if status != "partially_verified" {
                liveClosureEnabled = false
                return result
            }
            guard let anchor else { throw AuditInputError("Native audit anchor is missing") }
            let metadata = try await anchor.persistCheckpoint(
                head: .object(["sequence": result["sequence"] ?? .null, "hash": result["hash"] ?? .null]))
            _ = try await send("checkpoint", metadata.bridgePayload)
            checkpointMetadataSyncedThisLaunch = true
            var fields = result.objectValue ?? [:]
            fields["status"] = .string("verified")
            return .object(fields)
        } catch {
            liveClosureEnabled = false
            throw error
        }
    }

    // MARK: - Restore

    /// `assertRestoredAuditHistory`.
    public func assertRestoredAuditHistory(allowUnverifiedAudit: Bool) async throws -> JSONValue {
        if allowUnverifiedAudit {
            // The explicit recovery verifies the restored chain on its own. An older backup
            // cannot contain the current trusted checkpoint, so it must not be enrolled or
            // used to lower the external receipt.
            let candidate = try Self.requireValue(try await send("verify", .object([:])))
            guard candidate["status"]?.stringValue == "unavailable",
                let sequence = AuditJSON.safeInteger(candidate["sequence"]), sequence >= 0,
                AuditJSON.isHash(candidate["hash"])
            else {
                throw AuditRestoreError(
                    code: "RESTORED_AUDIT_RECOVERY_INVALID", message: "Restored database audit chain is invalid")
            }
            endAuditSession()
            return Self.outcome("unavailable", "explicit_recovery")
        }
        let result: JSONValue
        do {
            result = try await verifyAuditHistory(forRestore: true)
        } catch {
            throw AuditRestoreError(
                code: "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
                message: "Restored database audit verification is unavailable", auditStatus: "unavailable",
                auditReason: "bridge_unavailable")
        }
        let status = result["status"]?.stringValue
        guard status == "verified" else {
            let failed = status == "failed"
            throw AuditRestoreError(
                code: failed ? "RESTORED_AUDIT_INTEGRITY_FAILED" : "RESTORED_AUDIT_INTEGRITY_UNAVAILABLE",
                message: failed
                    ? "Restored database failed the trusted audit integrity check"
                    : "Restored database cannot be verified against the trusted audit checkpoint",
                auditStatus: status, auditReason: result["reason"]?.stringValue)
        }
        return result
    }
}
