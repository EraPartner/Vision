import Foundation
import Testing
@testable import VisionNativeCore

// The six `electronAudit` channels against a fake shell and a runtime on a fake backend,
// plus the viewer's snapshot checks and export.

/// The app side of the audit channels: scripted answers, recorded dialogs and notices.
@MainActor
final class FakeAuditShell: AuditShell {
    var strings = ShellStrings(language: .en, table: [:])
    var confirmAnswers: [Bool] = []
    var saveLocation: String?
    var chosenFile: String?
    private(set) var confirmations: [AuditConfirmation] = []
    private(set) var savePanels: [AuditFilePanel] = []
    private(set) var openPanels: [AuditFilePanel] = []
    private(set) var notices: [String] = []

    func confirm(_ confirmation: AuditConfirmation) async -> Bool {
        confirmations.append(confirmation)
        return confirmAnswers.isEmpty ? false : confirmAnswers.removeFirst()
    }

    func chooseSaveLocation(_ panel: AuditFilePanel) async -> String? {
        savePanels.append(panel)
        return saveLocation
    }

    func chooseFile(_ panel: AuditFilePanel) async -> String? {
        openPanels.append(panel)
        return chosenFile
    }

    func showAuditNotice(_ message: String) {
        notices.append(message)
    }
}

private let failedNotice =
    "Audit integrity check failed. Open Admin > Audit before trusting recent changes. Preserve your backup and audit checkpoint."
private let unavailableNotice =
    "Audit integrity protection is unavailable. Open Admin > Audit to check its status. Your data remains accessible; no checkpoint has been reset."
private let enrollmentNotice =
    "Audit protection has not been started. Open Admin > Audit to review the history and explicitly start protection."
private let partialNotice =
    "Recent changes are not independently verified. Open Admin > Audit to review the checkpoint before trusting them."
private let channelsUnavailable = JSONValue.object(["success": .bool(false), "status": .string("unavailable")])
private let channelsCancelled = JSONValue.object(["success": .bool(false), "cancelled": .bool(true)])
private let transferPassword = "a transfer password"

private func channelFailure(reason: String) -> JSONValue {
    .object(["success": .bool(false), "status": .string("failed"), "reason": .string(reason)])
}

private func channelUnanchored(_ sequence: Int) -> JSONValue {
    .object([
        "status": .string("unavailable"), "sequence": .int(sequence), "hash": .string(auditHash("head \(sequence)")),
        "legacyCutover": auditCutover,
        "legacyUnverified": .object(["db_editor": .string("0"), "split": .string("0"), "retag": .string("0")]),
    ])
}

private func channelVerified(_ sequence: Int) -> JSONValue {
    .object([
        "status": .string("verified"), "sequence": .int(sequence), "hash": .string(auditHash("head \(sequence)")),
        "legacyCutover": auditCutover,
    ])
}

/// One entry of a verified page.
private func viewerEntry(_ sequence: Int, _ anchorStatus: String = "anchored") -> JSONValue {
    .object([
        "sequence": .int(sequence), "previousHash": .string(auditHash("entry \(sequence - 1)")),
        "hash": .string(auditHash("entry \(sequence)")), "version": .int(1), "payload": .object([:]),
        "createdAt": .string("2026-01-01T00:00:00.000Z"), "anchorStatus": .string(anchorStatus),
    ])
}

private func viewerVerification(
    _ status: String = "verified", head: Int, anchored: Int? = nil, extra: [String: JSONValue] = [:]
) -> JSONValue {
    var fields: [String: JSONValue] = [
        "status": .string(status), "sequence": .int(head), "hash": .string(auditHash("head \(head)")),
        "anchoredThrough": .int(anchored ?? head), "legacyCutover": auditCutover,
    ]
    for (key, value) in extra { fields[key] = value }
    return .object(fields)
}

private func viewerPage(_ verification: JSONValue, _ entries: [JSONValue], hasMore: Bool = false) -> JSONValue {
    .object(["verification": verification, "entries": .array(entries), "hasMore": .bool(hasMore)])
}

@MainActor
private struct ChannelFixture {
    let anchorFixture: AnchorFixture
    let backend: FakeAuditBackend
    let shell: FakeAuditShell
    let runtime: AuditRuntime
    let channels: AuditChannels

    init() throws {
        let anchorFixture = try AnchorFixture()
        let backend = FakeAuditBackend()
        let shell = FakeAuditShell()
        let runtime = AuditRuntime(
            anchor: anchorFixture.anchor, transport: backend, newClusterCreatedThisLaunch: { false })
        self.anchorFixture = anchorFixture
        self.backend = backend
        self.shell = shell
        self.runtime = runtime
        channels = AuditChannels(runtimeProvider: { runtime }, shell: shell, log: { _ in })
    }

    var anchor: AuditAnchor { anchorFixture.anchor }
    var directory: String { anchorFixture.directory }

    func remove() {
        channels.stopClosureTimer()
        anchorFixture.remove()
    }
}

@Suite struct AuditChannelsTests {
    @Test @MainActor func withoutARuntimeEveryChannelIsUnavailable() async {
        let shell = FakeAuditShell()
        shell.confirmAnswers = [true, true]
        shell.chosenFile = "/tmp/never-read.vat"
        let channels = AuditChannels(runtimeProvider: { nil }, shell: shell, log: { _ in })
        let enroll = await channels.enroll()
        let read = await channels.read(AuditViewer.ReadRange(afterSequence: 0, limit: 100))
        let export = await channels.exportSnapshot()
        let transferExport = await channels.exportTransfer(password: transferPassword)
        let transferImport = await channels.importTransfer(password: transferPassword)
        let rotate = await channels.rotateKey()
        for result in [enroll, read, export, transferExport, transferImport, rotate] {
            #expect(result == channelsUnavailable)
        }
        // Nothing is asked before the runtime is known to exist.
        #expect(shell.confirmations.isEmpty)
        #expect(shell.openPanels.isEmpty)
        #expect(shell.savePanels.isEmpty)
        let status = await channels.checkIntegrity()
        #expect(status == nil)
        #expect(shell.notices.isEmpty)
    }

    @Test @MainActor func enrollmentAsksFirstAndReportsTheBaseline() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }

        fixture.backend.answer("verify", channelUnanchored(4))
        let cancelled = await fixture.channels.enroll()
        #expect(cancelled == channelsCancelled)
        let asked = try #require(fixture.shell.confirmations.first)
        #expect(asked.title == "Start audit protection")
        #expect(asked.confirmLabel == "Start protection")
        #expect(asked.cancelLabel == "Cancel")

        fixture.shell.confirmAnswers = [true]
        fixture.backend.answer("verify", channelUnanchored(4))
        fixture.backend.answer("verify", channelUnanchored(4))
        fixture.backend.answer("verify", channelVerified(4))
        fixture.backend.always("checkpoint", .object([:]))
        let enrolled = await fixture.channels.enroll()
        #expect(enrolled == .object(["success": .bool(true), "enrollmentSequence": .int(4)]))
        #expect(fixture.shell.notices.isEmpty)

        // An anchored history is not enrolled again; the status comes back as is.
        fixture.backend.answer("verify", channelVerified(4))
        let again = await fixture.channels.enroll()
        #expect(again == .object(["success": .bool(false), "status": .string("verified")]))
        #expect(fixture.shell.confirmations.count == 2)
    }

    @Test @MainActor func readReturnsAVerifiedPageOrTheStatus() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }
        let range = AuditViewer.ReadRange(afterSequence: 0, limit: 100)

        let unanchored = await fixture.channels.read(range)
        #expect(
            unanchored
                == .object([
                    "success": .bool(false), "status": .string("unavailable"), "reason": .string("no_trusted_anchor"),
                ]))
        #expect(fixture.shell.notices == [enrollmentNotice])

        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(2), legacyCutover: auditCutover)
        let verification = viewerVerification(head: 2)
        let entries = [viewerEntry(1), viewerEntry(2)]
        fixture.backend.answer("read", viewerPage(verification, entries))
        let page = await fixture.channels.read(range)
        #expect(
            page
                == .object([
                    "success": .bool(true), "verification": verification, "entries": .array(entries),
                    "hasMore": .bool(false),
                ]))

        // The backend's page disagrees with the receipt: failed, and noticed again after
        // the verified page cleared the previous notice.
        fixture.backend.answer("read", viewerPage(viewerVerification(head: 2, anchored: 1), entries))
        let failed = await fixture.channels.read(range)
        #expect(failed == .object(["success": .bool(false), "status": .string("failed")]))
        #expect(fixture.shell.notices == [enrollmentNotice, failedNotice])
    }

    @Test @MainActor func exportSnapshotSavesWhereTheUserSays() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }
        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(2), legacyCutover: auditCutover)
        fixture.backend.always("read", viewerPage(viewerVerification(head: 2), [viewerEntry(1), viewerEntry(2)]))

        let cancelled = await fixture.channels.exportSnapshot()
        #expect(cancelled == channelsCancelled)
        let panel = try #require(fixture.shell.savePanels.first)
        #expect(panel.title == "Export audit snapshot")
        #expect(panel.defaultName == "vision-audit-snapshot.json")
        #expect(panel.extensions == ["json"])

        let target = fixture.directory + "/snapshot.json"
        fixture.shell.saveLocation = target
        let saved = await fixture.channels.exportSnapshot()
        #expect(saved == .object(["success": .bool(true), "file": .string(target)]))
        let written = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: target)))
        #expect(written["format"] == .string("vision-audit-view-v1"))
        #expect(written["entries"]?.arrayValue?.count == 2)
        let attributes = try FileManager.default.attributesOfItem(atPath: target)
        #expect((attributes[.posixPermissions] as? NSNumber)?.intValue == 0o600)
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: fixture.directory)
        #expect(!leftovers.contains { $0.hasSuffix(".tmp") })
    }

    @Test @MainActor func transferExportNeedsAVerifiedHistoryAndATarget() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }
        fixture.backend.answer("verify", channelUnanchored(2))
        let unverified = await fixture.channels.exportTransfer(password: transferPassword)
        #expect(unverified == channelFailure(reason: "history_unverified"))

        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(2), legacyCutover: auditCutover)
        fixture.backend.always("verify", channelVerified(2))
        let short = await fixture.channels.exportTransfer(password: "short")
        #expect(short == channelFailure(reason: "transfer_password_invalid"))

        let cancelled = await fixture.channels.exportTransfer(password: transferPassword)
        #expect(cancelled == channelsCancelled)
        let panel = try #require(fixture.shell.savePanels.first)
        #expect(panel.defaultName == "vision-audit-transfer.vat")
        #expect(panel.extensions == ["vat"])

        let target = fixture.directory + "/transfer.vat"
        fixture.shell.saveLocation = target
        let saved = await fixture.channels.exportTransfer(password: transferPassword)
        #expect(saved == .object(["success": .bool(true)]))
        let envelope = try JSONValue.parse(Data(contentsOf: URL(fileURLWithPath: target)))
        #expect(envelope["format"] == .string("vision-audit-transfer"))
    }

    @Test @MainActor func transferImportChecksTheFileBeforeTheRuntime() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }

        let noFile = await fixture.channels.importTransfer(password: transferPassword)
        #expect(noFile == channelsCancelled)
        #expect(fixture.shell.openPanels.first?.extensions == ["vat"])
        #expect(fixture.shell.confirmations.isEmpty)

        let missing = fixture.directory + "/missing.vat"
        fixture.shell.chosenFile = missing
        let declined = await fixture.channels.importTransfer(password: transferPassword)
        #expect(declined == channelsCancelled)
        #expect(fixture.shell.confirmations.first?.confirmLabel == "Import transfer")

        fixture.shell.confirmAnswers = [true]
        let notFound = await fixture.channels.importTransfer(password: transferPassword)
        #expect(notFound == channelFailure(reason: "ENOENT"))

        let real = fixture.directory + "/real.vat"
        try writeBytes(real, Array("{}".utf8))
        let link = fixture.directory + "/link.vat"
        try FileManager.default.createSymbolicLink(atPath: link, withDestinationPath: real)
        fixture.shell.chosenFile = link
        fixture.shell.confirmAnswers = [true]
        let symlink = await fixture.channels.importTransfer(password: transferPassword)
        #expect(symlink == channelFailure(reason: "ELOOP"))

        let large = fixture.directory + "/large.vat"
        try writeBytes(large, [UInt8](repeating: 0x20, count: AuditAnchor.transferMaximumBytes + 1))
        fixture.shell.chosenFile = large
        fixture.shell.confirmAnswers = [true]
        let oversized = await fixture.channels.importTransfer(password: transferPassword)
        #expect(oversized == channelFailure(reason: "transfer_invalid"))

        // A readable file reaches the runtime, which refuses an install that is not new.
        fixture.shell.chosenFile = real
        fixture.shell.confirmAnswers = [true]
        let notFresh = await fixture.channels.importTransfer(password: transferPassword)
        #expect(notFresh == channelFailure(reason: "transfer_target_not_fresh"))
    }

    @Test @MainActor func rotationAsksFirstAndReturnsTheSequence() async throws {
        let fixture = try ChannelFixture()
        defer { fixture.remove() }

        let cancelled = await fixture.channels.rotateKey()
        #expect(cancelled == channelsCancelled)
        #expect(fixture.shell.confirmations.first?.title == "Rotate audit key")

        fixture.shell.confirmAnswers = [true]
        fixture.backend.answer("verify", channelUnanchored(2))
        let unverified = await fixture.channels.rotateKey()
        #expect(unverified == channelFailure(reason: "history_unverified"))
        #expect(fixture.shell.notices == [failedNotice])

        _ = try await fixture.anchor.initializeFirstCheckpoint(head: auditHead(2), legacyCutover: auditCutover)
        let before = try await fixture.anchor.readTrustedCheckpoint()
        fixture.backend.always("verify", channelVerified(2))
        fixture.backend.always("checkpoint", .object([:]))
        fixture.shell.confirmAnswers = [true]
        let rotated = await fixture.channels.rotateKey()
        #expect(rotated == .object(["success": .bool(true), "sequence": .int(2)]))
        let after = try await fixture.anchor.readTrustedCheckpoint()
        #expect(after.metadata.receiptId != before.metadata.receiptId)
        #expect(fixture.backend.endpoints().last == "checkpoint")
    }

    @Test @MainActor func theRecoveryConfirmationNamesTheStatus() async {
        let shell = FakeAuditShell()
        shell.confirmAnswers = [true, false, false, false]
        let channels = AuditChannels(runtimeProvider: { nil }, shell: shell, log: { _ in })
        let failed = await channels.confirmAuditRecovery(fileName: "a.zip", auditStatus: "failed")
        let verified = await channels.confirmAuditRecovery(fileName: "b.zip", auditStatus: "verified")
        let partial = await channels.confirmAuditRecovery(fileName: "c.zip", auditStatus: "partially_verified")
        let absent = await channels.confirmAuditRecovery(fileName: "d.zip", auditStatus: nil)
        #expect(failed)
        #expect(!verified)
        #expect(!partial)
        #expect(!absent)
        #expect(
            shell.confirmations.map(\.detail)
                == ["a.zip (failed)", "b.zip (unavailable)", "c.zip (partially_verified)", "d.zip (unavailable)"])
        let first = shell.confirmations[0]
        #expect(first.title == "Audit continuity cannot be verified")
        #expect(first.confirmLabel == "Restore")
        #expect(first.cancelLabel == "Cancel")
    }

    @Test @MainActor func aNoticeIsShownOnceUntilTheStatusChanges() async {
        var state = AuditNoticeState()
        let first = state.report("unavailable")
        let repeated = state.report("unavailable")
        let failed = state.report("failed")
        let cleared = state.report("verified")
        let clearedLast = state.last
        let again = state.report("unavailable")
        let undefined = state.report(nil)
        let undefinedLast = state.last
        let undefinedAgain = state.report(nil)
        #expect(first == "app.auditUnavailable")
        #expect(repeated == nil)
        #expect(failed == "app.auditFailed")
        #expect(cleared == nil)
        #expect(clearedLast == nil)
        #expect(again == "app.auditUnavailable")
        #expect(undefined == "app.auditUnavailable")
        #expect(undefinedLast == "undefined")
        #expect(undefinedAgain == nil)

        // main.ts `reportAuditStatus(status, reason)`: a missing anchor asks for enrollment,
        // and a partially verified history has its own notice.
        var reasons = AuditNoticeState()
        let enrollment = reasons.report("unavailable", reason: "no_trusted_anchor")
        let enrollmentAgain = reasons.report("unavailable", reason: "no_trusted_anchor")
        let otherUnavailable = reasons.report("unavailable", reason: "bridge_or_anchor_unavailable")
        let partial = reasons.report("partially_verified")
        #expect(enrollment == "app.auditEnrollmentRequired")
        #expect(enrollmentAgain == nil)
        #expect(otherUnavailable == "app.auditUnavailable")
        #expect(partial == "app.auditPartial")
        let fallbackStrings = ShellStrings(language: .en, table: [:])
        #expect(AuditNoticeState.message("app.auditEnrollmentRequired", strings: fallbackStrings) == enrollmentNotice)
        #expect(AuditNoticeState.message("app.auditPartial", strings: fallbackStrings) == partialNotice)

        let shell = FakeAuditShell()
        shell.strings = ShellStrings(language: .nl, table: ["app.auditFailed": "Auditcontrole mislukt."])
        let channels = AuditChannels(runtimeProvider: { nil }, shell: shell, log: { _ in })
        channels.report("failed")
        channels.report("failed")
        channels.report("unavailable")
        channels.report("verified")
        channels.report("unavailable")
        #expect(shell.notices == ["Auditcontrole mislukt.", unavailableNotice, unavailableNotice])
    }
}

@Suite struct AuditViewerSnapshotTests {
    private let range = AuditViewer.ReadRange(afterSequence: 0, limit: 100)

    @Test func aCompletePageReachingTheHeadIsAccepted() throws {
        let verification = viewerVerification(head: 2)
        var raw = viewerPage(verification, [viewerEntry(1), viewerEntry(2)]).objectValue ?? [:]
        raw["extra"] = .string("dropped")
        let snapshot = try AuditViewer.validateSnapshot(.object(raw), range: range)
        #expect(snapshot == viewerPage(verification, [viewerEntry(1), viewerEntry(2)]))

        // A partially verified head: entries past the anchored prefix are pending.
        let partial = viewerVerification("partially_verified", head: 3, anchored: 2)
        let pending = viewerPage(partial, [viewerEntry(1), viewerEntry(2), viewerEntry(3, "pending_anchor")])
        #expect(try AuditViewer.validateSnapshot(pending, range: range) == pending)

        // Retention moves the floor; the page starts after the pruned prefix.
        let retained = viewerVerification(head: 3, extra: ["retentionThrough": .int(1)])
        let afterRetention = viewerPage(retained, [viewerEntry(2), viewerEntry(3)])
        #expect(try AuditViewer.validateSnapshot(afterRetention, range: range) == afterRetention)

        // A first page that is not the last one.
        let first = viewerPage(verification, [viewerEntry(1)], hasMore: true)
        #expect(try AuditViewer.validateSnapshot(first, range: AuditViewer.ReadRange(afterSequence: 0, limit: 1)) == first)
    }

    @Test func malformedPagesAreRefused() {
        let verification = viewerVerification(head: 2)
        #expect(throws: AuditViewer.ViewerError("Audit snapshot is unavailable")) {
            try AuditViewer.validateSnapshot(.array([]), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit history cannot be verified")) {
            try AuditViewer.validateSnapshot(
                viewerPage(viewerVerification("failed", head: 2), [viewerEntry(1), viewerEntry(2)]), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit history cannot be verified")) {
            try AuditViewer.validateSnapshot(
                viewerPage(verification, [viewerEntry(1), viewerEntry(2)]),
                range: AuditViewer.ReadRange(afterSequence: 0, limit: 1))
        }
        #expect(throws: AuditViewer.ViewerError("Audit history cannot be verified")) {
            try AuditViewer.validateSnapshot(
                viewerPage(viewerVerification(head: 3, extra: ["retentionThrough": .int(3)]), []), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit status disagrees with anchored prefix")) {
            try AuditViewer.validateSnapshot(
                viewerPage(viewerVerification(head: 2, anchored: 1), [viewerEntry(1), viewerEntry(2, "pending_anchor")]),
                range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit entry is malformed")) {
            try AuditViewer.validateSnapshot(viewerPage(verification, [viewerEntry(1), viewerEntry(3)]), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit entry is malformed")) {
            try AuditViewer.validateSnapshot(
                viewerPage(verification, [viewerEntry(1), viewerEntry(2, "pending_anchor")]), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit page is incomplete")) {
            try AuditViewer.validateSnapshot(
                viewerPage(verification, [viewerEntry(1), viewerEntry(2)], hasMore: true), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit page is incomplete")) {
            try AuditViewer.validateSnapshot(viewerPage(verification, [], hasMore: true), range: range)
        }
        #expect(throws: AuditViewer.ViewerError("Audit page does not reach the verified head")) {
            try AuditViewer.validateSnapshot(viewerPage(verification, [viewerEntry(1)]), range: range)
        }
    }

    @Test func theExportIsPrettyJSONWithTheRightWarning() throws {
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let snapshot = viewerPage(viewerVerification(head: 2), [viewerEntry(1), viewerEntry(2)])
        let content = try AuditViewer.buildExport(snapshot, now: now)
        #expect(content.hasPrefix("{\n  \"format\": \"vision-audit-view-v1\",\n  \"exportedAt\": "))
        #expect(content.hasSuffix("\n}\n"))
        let parsed = try JSONValue.parse(Data(content.utf8))
        #expect(parsed["exportedAt"] == .string(isoTimestamp(now)))
        #expect(
            parsed["warning"]
                == .string(
                    "This export is a snapshot verified against this installation's local receipt and Keychain checkpoint. It is not a signed report or remote attestation."
                ))
        #expect(parsed["verification"] == snapshot["verification"])
        #expect(parsed["entries"] == snapshot["entries"])

        let enrolled = viewerPage(
            viewerVerification(head: 3, extra: ["retentionThrough": .int(1), "enrollmentSequence": .int(2)]),
            [viewerEntry(2), viewerEntry(3)])
        let warning = try JSONValue.parse(Data(try AuditViewer.buildExport(enrolled, now: now).utf8))["warning"]
        let text = try #require(warning?.stringValue)
        #expect(text.hasPrefix("Entries through sequence 1 were pruned under the one-year retention policy. "))
        #expect(text.contains("Entries through the enrollment baseline were accepted at enrollment"))
    }

    @Test func anIncompleteHistoryIsNotExported() {
        let verification = viewerVerification(head: 2)
        #expect(throws: AuditViewer.ViewerError("Audit history exceeds the 500 entry export limit")) {
            try AuditViewer.buildExport(viewerPage(verification, [viewerEntry(1)], hasMore: true))
        }
        #expect(throws: AuditViewer.ViewerError("Audit history exceeds the 500 entry export limit")) {
            try AuditViewer.buildExport(viewerPage(verification, [viewerEntry(1)]))
        }
    }
}
