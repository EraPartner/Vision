import Foundation
import Testing
@testable import VisionNativeCore

// The backup channels end to end against a fake runtime and real files.

actor FakeBackupSettings: BackupSettingsStore {
    private var values: [String: JSONValue]

    init(_ values: [String: JSONValue] = [:]) {
        self.values = values
    }

    func currentSettings() async -> [String: JSONValue] { values }

    func updateSettings(_ update: @Sendable (inout [String: JSONValue]) -> Void) async throws {
        update(&values)
    }
}

struct FakeRuntimeFailure: Error, LocalizedError {
    let message: String
    var errorDescription: String? { message }
}

actor FakeBackupRuntime: BackupRuntime {
    private(set) var calls: [String] = []
    private(set) var restoredDump: String?
    private(set) var restoredAttachments: [String] = []
    private var head: String
    private var startFailures: Int
    private let schemaHeadFails: Bool
    private let chainHead: String
    private var dumpGate: (entered: Latch, release: Latch)?
    private var restoreGate: (entered: Latch, release: Latch)?
    private var startsBeforeFailing: Int?

    init(head: String = "0130_head", startFailures: Int = 0, schemaHeadFails: Bool = false, chainHead: String = "") {
        self.head = head
        self.startFailures = startFailures
        self.schemaHeadFails = schemaHeadFails
        self.chainHead = chainHead
    }

    func holdDump(entered: Latch, release: Latch) {
        dumpGate = (entered, release)
    }

    func holdRestore(entered: Latch, release: Latch) {
        restoreGate = (entered, release)
    }

    /// Lets `count` backend starts succeed, then fails every later one.
    func failStarts(after count: Int) {
        startsBeforeFailing = count
    }

    func dumpDatabase(to destination: String) async throws {
        calls.append("dump")
        if let gate = dumpGate {
            gate.entered.open()
            await gate.release.wait()
        }
        try writeBytes(destination, Array("-- dump\nINSERT INTO alembic_version VALUES ('\(head)');\n".utf8))
    }

    func exportAttachments(to destination: String) async throws {
        calls.append("export")
        try BackupFiles.createDirectory(destination + "/tx-1")
        try writeBytes(destination + "/tx-1/receipt.txt", Array("receipt".utf8))
    }

    func schemaHead() async throws -> String {
        if schemaHeadFails { throw FakeRuntimeFailure(message: "relation alembic_version does not exist") }
        return head
    }

    func migrationChainHead() async -> String { chainHead }

    func stop(keepPostgres: Bool) async throws {
        calls.append("stop:\(keepPostgres)")
    }

    func activateRestoredDatabase(_ path: String, format: RestoreFormat, expectedSchemaHead: String) async throws
        -> DatabaseSwitchToken
    {
        calls.append("activate:\(format.rawValue):\(expectedSchemaHead)")
        if let gate = restoreGate {
            gate.entered.open()
            await gate.release.wait()
        }
        restoredDump = try String(contentsOfFile: path, encoding: .utf8)
        return DatabaseSwitchToken(
            version: 1, liveDatabase: "vision", previousDatabase: "vision_previous", activatedDatabase: "vision",
            activatedAt: "2025-10-09T08:53:20.125Z")
    }

    func replaceAttachments(from source: String) async throws -> DirectorySwitchToken {
        calls.append("replaceAttachments")
        let fingerprint = try DirectorySwitch.fingerprint(source)
        restoredAttachments = fingerprint.entries.map(\.path)
        return DirectorySwitchToken(
            count: fingerprint.count, digest: fingerprint.digest, entries: fingerprint.entries,
            previousDirectory: "/data/attachments.previous-x", destinationDirectory: "/data/attachments")
    }

    func startBackendAndWait() async throws {
        calls.append("start")
        if let remaining = startsBeforeFailing {
            if remaining == 0 { throw FakeRuntimeFailure(message: "backend did not become ready") }
            startsBeforeFailing = remaining - 1
        }
        if startFailures > 0 {
            startFailures -= 1
            throw FakeRuntimeFailure(message: "backend did not become ready")
        }
    }

    func finalizeDatabaseSwitch(_ token: DatabaseSwitchToken) async throws {
        calls.append("finalizeDatabase")
    }

    func rollbackDatabaseSwitch(_ token: JSONValue?) async throws {
        calls.append("rollbackDatabase:\(token?["previousDatabase"]?.stringValue ?? "")")
    }

    func finalizeAttachmentSwitch(_ token: DirectorySwitchToken) async throws {
        calls.append("finalizeAttachments")
    }

    func rollbackAttachmentSwitch(_ token: DirectorySwitchToken) async throws {
        calls.append("rollbackAttachments")
    }
}

private struct ServiceFixture {
    let directory: String
    let runtime: FakeBackupRuntime
    let settings: FakeBackupSettings
    let store: InMemoryPassphraseStore
    let log: RecordingLog
    let service: BackupService

    init(
        environment: [String: String] = [:], runtime: FakeBackupRuntime = FakeBackupRuntime(),
        storedPassphrase: String? = nil, runtimeAvailable: Bool = true,
        maintenance: BackupMaintenanceHooks = BackupMaintenanceHooks()
    ) throws {
        let directory = try makeBackupScratchDirectory()
        try BackupFiles.createDirectory(directory + "/tmp")
        let settings = FakeBackupSettings()
        let store = InMemoryPassphraseStore(storedPassphrase)
        let log = RecordingLog()
        let provided: (any BackupRuntime)? = runtimeAvailable ? runtime : nil
        self.directory = directory
        self.runtime = runtime
        self.settings = settings
        self.store = store
        self.log = log
        service = BackupService(
            context: BackupContext(
                environment: environment, appVersion: "2.0.0", userDataDirectory: directory + "/userData",
                homeDirectory: directory, appName: "Vision Native", temporaryDirectory: directory + "/tmp"),
            settings: settings,
            runtimeProvider: { provided },
            passphraseStoreFactory: { _ in store },
            logger: log,
            now: { Date(timeIntervalSince1970: 1_760_000_000.125) },
            maintenance: maintenance)
    }

    var backups: String { directory + "/Backups" }

    func remove() {
        try? FileManager.default.removeItem(atPath: directory)
    }
}

@Suite struct BackupServiceTests {
    @Test func writesAPlainBundleWithAWarningWithoutAPassphrase() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let result = await fixture.service.runBackup(
            destination: fixture.backups, frontendStateJson: "{\"keys\":{\"vision.language\":\"nl\"}}")
        let deviceId = try await fixture.service.deviceId()
        let expected = fixture.backups + "/vision_backup_\(deviceId)_2025-10-09_08-53-20.visionbak"
        #expect(
            result
                == .object([
                    "success": .bool(true), "file": .string(expected), "encrypted": .bool(false),
                    "cleanupRemoved": .int(0), "warning": .string("Backup encryption skipped: no passphrase configured."),
                ]))
        let stored = await fixture.settings.currentSettings()
        #expect(stored["backupDeviceId"] == .string(deviceId))

        let opened = try BackupBundle.open(expected, passphrase: nil, temporaryParent: fixture.directory)
        defer { opened.cleanup() }
        #expect(opened.metadata["schemaHead"] == .string("0130_head"))
        #expect(opened.metadata["appVersion"] == .string("2.0.0"))
        #expect(opened.metadata["deviceId"] == .string(deviceId))
        #expect(opened.frontendState == .object(["keys": .object(["vision.language": .string("nl")])]))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: fixture.directory + "/tmp")
        #expect(leftovers.isEmpty)
    }

    @Test func anEncryptedBackupRestoresWithTheEnvironmentPassphrase() async throws {
        let fixture = try ServiceFixture(environment: ["VISION_BACKUP_PASSPHRASE": "env secret"])
        defer { fixture.remove() }
        let result = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: "{\"keys\":{}}")
        #expect(result["success"] == .bool(true))
        #expect(result["encrypted"] == .bool(true))
        #expect(result["warning"] == nil)
        let file = try #require(result["file"]?.stringValue)
        #expect(file.hasSuffix(".visionbak.enc"))
        let encrypted = await fixture.service.isEncrypted(file)
        #expect(encrypted)

        let restored = await fixture.service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(
            restored
                == .object([
                    "success": .bool(true), "file": .string(file), "frontendState": .object(["keys": .object([:])]),
                ]))
        let calls = await fixture.runtime.calls
        #expect(
            calls == [
                "stop:true", "dump", "export", "start", "activate:plain:0130_head", "replaceAttachments", "start",
                "finalizeDatabase", "finalizeAttachments",
            ])
        let dump = await fixture.runtime.restoredDump
        #expect(dump?.contains("0130_head") == true)
        let attachments = await fixture.runtime.restoredAttachments
        #expect(attachments == ["tx-1/receipt.txt"])

        let wrong = await fixture.service.restore(path: file, passphrase: "not it", confirm: { true })
        #expect(wrong == .object(["success": .bool(false), "error": .string("Error: INVALID_PASSPHRASE")]))
    }

    @Test func anEncryptedBundleWithoutAnyPassphraseNeedsOne() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let path = try BackupFixture.path()
        let result = await fixture.service.restore(path: path, passphrase: nil, confirm: { true })
        #expect(result == .object(["success": .bool(false), "error": .string("Error: PASSPHRASE_REQUIRED")]))
        let calls = await fixture.runtime.calls
        #expect(calls.isEmpty)
    }

    @Test func theVision102FixtureRestoresWithItsSchemaUnchecked() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let path = try BackupFixture.path()
        let result = await fixture.service.restore(path: path, passphrase: BackupFixture.passphrase, confirm: { true })
        #expect(result["success"] == .bool(true))
        #expect(result["frontendState"] == .object(["keys": .object(["vision.language": .string("nl")])]))
        let calls = await fixture.runtime.calls
        #expect(calls.first == "activate:plain:fixture_schema")
        let attachments = await fixture.runtime.restoredAttachments
        #expect(attachments == ["tx-001/receipt.txt"])
    }

    @Test func aBundleFromANewerSchemaIsRefused() async throws {
        let fixture = try ServiceFixture(runtime: FakeBackupRuntime(head: "0131_next"))
        defer { fixture.remove() }
        let backup = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)

        let older = try ServiceFixture(runtime: FakeBackupRuntime(head: "0130_head"))
        defer { older.remove() }
        let result = await older.service.restore(path: file, passphrase: nil, confirm: { true })
        let error = try #require(result["error"]?.stringValue)
        #expect(error.hasPrefix("Error: BUNDLE_SCHEMA_NEWER: This bundle was created on schema revision \"0131_next\""))
        let calls = await older.runtime.calls
        #expect(calls.isEmpty)
    }

    @Test func aBackendThatDoesNotStartRollsBackBothSwitches() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let backup = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)
        await fixture.runtime.failStarts(after: 0)
        let result = await fixture.service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(result == .object(["success": .bool(false), "error": .string("Error: backend did not become ready")]))
        let calls = await fixture.runtime.calls
        #expect(
            Array(calls.dropFirst(4)) == [
                "activate:plain:0130_head", "replaceAttachments", "start", "rollbackAttachments",
                "rollbackDatabase:vision_previous", "start",
            ])
        #expect(fixture.log.lines.contains { $0.contains("restore rollback failed: backend did not become ready") })
    }

    @Test func aLegacySqlDumpRestoresWithItsSchemaHead() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let path = fixture.directory + "/legacy.sql"
        try writeBytes(path, Array("INSERT INTO public.alembic_version (version_num) VALUES ('0042_x');\n".utf8))
        let encrypted = await fixture.service.isEncrypted(path)
        #expect(!encrypted)
        let result = await fixture.service.restore(path: path, passphrase: nil, confirm: { true })
        #expect(result == .object(["success": .bool(true), "file": .string(path)]))
        let calls = await fixture.runtime.calls
        #expect(calls == ["activate:plain:0042_x", "start", "finalizeDatabase"])
    }

    @Test func missingFilesAndCancelledConfirmationsDoNothing() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let missing = await fixture.service.restore(
            path: fixture.directory + "/none.visionbak", passphrase: nil, confirm: { true })
        #expect(missing == .object(["success": .bool(false), "error": .string("Backup file not found")]))
        let path = fixture.directory + "/legacy.sql"
        try writeBytes(path, Array("SELECT 1;\n".utf8))
        let cancelled = await fixture.service.restore(path: path, passphrase: nil, confirm: { false })
        #expect(cancelled == .object(["success": .bool(false), "error": .string("Restore cancelled by user")]))
        let calls = await fixture.runtime.calls
        #expect(calls.isEmpty)
    }

    @Test func backupsNeedTheRuntime() async throws {
        let fixture = try ServiceFixture(runtimeAvailable: false)
        defer { fixture.remove() }
        let result = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        #expect(
            result
                == .object([
                    "success": .bool(false),
                    "error": .string("Error: Vision backup and restore require the native runtime"),
                ]))
    }

    @Test func oneBackupRunsAtATimeAndTheQuitBackupWaitsForIt() async throws {
        let runtime = FakeBackupRuntime()
        let entered = Latch()
        let release = Latch()
        await runtime.holdDump(entered: entered, release: release)
        let fixture = try ServiceFixture(runtime: runtime)
        defer { fixture.remove() }
        let service = fixture.service
        let destination = fixture.backups

        let first = Task { await service.runBackup(destination: destination, frontendStateJson: nil) }
        await entered.wait()
        let second = await service.runBackup(destination: destination, frontendStateJson: nil)
        #expect(second == .object(["success": .bool(false), "error": .string("A backup is already in progress")]))

        let quit = Task {
            await service.runQuitBackup(rawSettings: .object(["backupDir": .string(destination), "backupOnQuit": .bool(true)]))
        }
        // Release the first backup only once the quit backup is waiting for it.
        let log = fixture.log
        for _ in 0..<2000 where !log.lines.contains(where: { $0.contains("quit: waiting") }) {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(log.lines.contains { $0.contains("quit: waiting") })
        release.open()
        let firstResult = await first.value
        _ = await quit.value
        #expect(firstResult["success"] == .bool(true))
        let calls = await runtime.calls
        #expect(calls.filter { $0 == "dump" }.count == 1)
    }

    @Test func theQuitBackupFollowsTheEffectiveSettings() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let disabled = await fixture.service.runQuitBackup(
            rawSettings: .object(["backupDir": .string(fixture.backups), "backupOnQuit": .bool(false)]))
        let unset = await fixture.service.runQuitBackup(rawSettings: nil)
        #expect(disabled == nil && unset == nil)
        let before = await fixture.runtime.calls
        #expect(before.isEmpty)

        let outcome = await fixture.service.runQuitBackup(
            rawSettings: .object(["backupDir": .string(fixture.backups), "backupOnQuit": .bool(true)]))
        #expect(outcome == .saved)
        let written = try FileManager.default.contentsOfDirectory(atPath: fixture.backups)
        #expect(written.count == 1)
        #expect(fixture.log.lines.contains { $0.contains("quit backup saved") })
    }

    @Test func thePassphraseChannelsUseTheStore() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        let initial = await fixture.service.encryptionStatus()
        #expect(initial == PassphraseStatus(hasEnvPassphrase: false, hasStoredPassphrase: false, secureStorageAvailable: true))
        let update = await fixture.service.setPassphrase("  stored secret \n")
        #expect(update == PassphraseUpdateResult(success: true, available: true))
        #expect(fixture.store.stored == "stored secret")
        let resolved = await fixture.service.passphrase()
        #expect(resolved == "stored secret")
        let after = await fixture.service.encryptionStatus()
        #expect(after.hasStoredPassphrase)
        let cleared = await fixture.service.setPassphrase("   ")
        #expect(cleared.success)
        #expect(fixture.store.stored == nil)
    }

    @Test func passphraseHandlerTrimsBOMAndClearsWhitespaceOnlyInput() async {
        let store = InMemoryPassphraseStore("previous synthetic password")
        let service = BackupService(
            context: BackupContext(
                environment: [:], appVersion: "test", userDataDirectory: "/synthetic", homeDirectory: "/synthetic",
                appName: "Synthetic"),
            settings: FakeBackupSettings(["backupDeviceId": .string("synthetic-device")]),
            runtimeProvider: { nil }, passphraseStoreFactory: { _ in store }, logger: RecordingLog())
        let raw = "\u{FEFF}\u{00A0}synthetic password\u{3000}\u{FEFF}"
        #expect(await service.setPassphrase(raw) == PassphraseUpdateResult(success: true, available: true))
        #expect(raw == "\u{FEFF}\u{00A0}synthetic password\u{3000}\u{FEFF}")
        #expect(await service.passphrase() == "synthetic password")
        #expect(await service.encryptionStatus().hasStoredPassphrase)

        #expect(await service.setPassphrase("\u{FEFF}\u{2028}\u{FEFF}").success)
        #expect(store.stored == nil)
        #expect(await service.passphrase() == nil)
        #expect(!(await service.encryptionStatus()).hasStoredPassphrase)
    }

    @Test func passphraseHandlerPreservesNELAsPasswordContent() async {
        let store = InMemoryPassphraseStore()
        let service = BackupService(
            context: BackupContext(
                environment: [:], appVersion: "test", userDataDirectory: "/synthetic", homeDirectory: "/synthetic",
                appName: "Synthetic"),
            settings: FakeBackupSettings(["backupDeviceId": .string("synthetic-device")]),
            runtimeProvider: { nil }, passphraseStoreFactory: { _ in store }, logger: RecordingLog())
        #expect(await service.setPassphrase("\u{FEFF}\u{0085}synthetic\u{0085}\u{FEFF}").success)
        #expect(await service.passphrase() == "\u{0085}synthetic\u{0085}")

        #expect(await service.setPassphrase(" \u{0085} ").success)
        #expect(store.stored == "\u{0085}")
        #expect(await service.encryptionStatus().hasStoredPassphrase)
    }

    @Test func theSchemaCheckFallsBackToThePayloadsMigrationChain() async throws {
        let source = try ServiceFixture(runtime: FakeBackupRuntime(head: "0130_head"))
        defer { source.remove() }
        let backup = await source.service.runBackup(destination: source.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)

        let current = try ServiceFixture(runtime: FakeBackupRuntime(schemaHeadFails: true, chainHead: "0130_head"))
        defer { current.remove() }
        let restored = await current.service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(restored["success"] == .bool(true))

        let older = try ServiceFixture(runtime: FakeBackupRuntime(schemaHeadFails: true, chainHead: "0129_prev"))
        defer { older.remove() }
        let refused = await older.service.restore(path: file, passphrase: nil, confirm: { true })
        let error = try #require(refused["error"]?.stringValue)
        #expect(error.hasPrefix("Error: BUNDLE_SCHEMA_NEWER:"))
    }

    @Test func anUnknownCurrentSchemaRefusesANumberedBackup() async throws {
        let source = try ServiceFixture()
        defer { source.remove() }
        let backup = await source.service.runBackup(destination: source.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)

        let unknown = try ServiceFixture(runtime: FakeBackupRuntime(schemaHeadFails: true))
        defer { unknown.remove() }
        let result = await unknown.service.restore(path: file, passphrase: nil, confirm: { true })
        let error = try #require(result["error"]?.stringValue)
        #expect(error.hasPrefix("Error: SCHEMA_UNKNOWN: This bundle was created on schema revision \"0130_head\""))
        let calls = await unknown.runtime.calls
        #expect(calls.isEmpty)

        let legacy = unknown.directory + "/legacy.sql"
        try writeBytes(legacy, Array("INSERT INTO alembic_version (version_num) VALUES ('0042_x');\n".utf8))
        let legacyResult = await unknown.service.restore(path: legacy, passphrase: nil, confirm: { true })
        let legacyError = try #require(legacyResult["error"]?.stringValue)
        #expect(legacyError.hasPrefix("Error: SCHEMA_UNKNOWN: This backup was created"))
    }

    @Test func backupsWaitForARunningRestore() async throws {
        let runtime = FakeBackupRuntime()
        let fixture = try ServiceFixture(runtime: runtime)
        defer { fixture.remove() }
        let backup = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)

        let entered = Latch()
        let release = Latch()
        await runtime.holdRestore(entered: entered, release: release)
        let service = fixture.service
        let restore = Task { await service.restore(path: file, passphrase: nil, confirm: { true }) }
        await entered.wait()

        let refused = await service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        #expect(refused == .object(["success": .bool(false), "error": .string("A restore is in progress")]))
        let second = await service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(second == .object(["success": .bool(false), "error": .string("A restore is already in progress")]))
        await service.runQuitBackup(
            rawSettings: .object(["backupDir": .string(fixture.backups), "backupOnQuit": .bool(true)]))
        #expect(fixture.log.lines.contains { $0.contains("a restore is in progress; skipping the quit backup") })

        release.open()
        let restored = await restore.value
        #expect(restored["success"] == .bool(true))
        let calls = await runtime.calls
        #expect(calls.filter { $0 == "dump" }.count == 1)
        let after = await service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        #expect(after["success"] == .bool(true))
    }
}

/// Native maintenance around a backup (main.ts `withBackupSnapshot`, `beginNativeMaintenance`
/// and `await nativeMaintenanceDone`).
@Suite struct BackupMaintenanceTests {
    @Test func theAppHooksSurroundTheQuiescentCapture() async throws {
        let runtime = FakeBackupRuntime()
        let events = StringBox()
        let fixture = try ServiceFixture(
            runtime: runtime,
            maintenance: BackupMaintenanceHooks(
                willBeginSnapshot: {
                    let count = await runtime.calls.count
                    events.append("begin:\(count)")
                },
                didEndSnapshot: {
                    let count = await runtime.calls.count
                    events.append("end:\(count)")
                }))
        defer { fixture.remove() }
        let result = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        #expect(result["success"] == .bool(true))
        #expect(events.values == ["begin:0", "end:4"])
        let calls = await runtime.calls
        #expect(calls == ["stop:true", "dump", "export", "start"])
    }

    @Test func aRestoreIsRefusedWhileABackupSnapshotRuns() async throws {
        let runtime = FakeBackupRuntime()
        let entered = Latch()
        let release = Latch()
        await runtime.holdDump(entered: entered, release: release)
        let fixture = try ServiceFixture(runtime: runtime)
        defer { fixture.remove() }
        let service = fixture.service
        let destination = fixture.backups
        let path = fixture.directory + "/legacy.sql"
        try writeBytes(path, Array("SELECT 1;\n".utf8))

        let backup = Task { await service.runBackup(destination: destination, frontendStateJson: nil) }
        await entered.wait()
        let asked = StringBox()
        let refused = await service.restore(
            path: path, passphrase: nil,
            confirm: {
                asked.append("confirm")
                return true
            })
        #expect(
            refused
                == .object([
                    "success": .bool(false),
                    "error": .string("A native backup, restore or update is already in progress"),
                ]))
        #expect(asked.values.isEmpty)

        // The quit waits for the running snapshot before the services stop.
        let waited = Flag(false)
        let quit = Task {
            await service.waitForMaintenance()
            waited.set(true)
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(!waited.current)
        release.open()
        let result = await backup.value
        await quit.value
        #expect(result["success"] == .bool(true))
        #expect(waited.current)
        let calls = await runtime.calls
        #expect(!calls.contains { $0.hasPrefix("activate") })
    }

    @Test func theQuitWaitsForARunningRestore() async throws {
        let runtime = FakeBackupRuntime()
        let fixture = try ServiceFixture(runtime: runtime)
        defer { fixture.remove() }
        let path = fixture.directory + "/legacy.sql"
        try writeBytes(path, Array("SELECT 1;\n".utf8))
        let entered = Latch()
        let release = Latch()
        await runtime.holdRestore(entered: entered, release: release)
        let service = fixture.service
        let restore = Task { await service.restore(path: path, passphrase: nil, confirm: { true }) }
        await entered.wait()

        let waited = Flag(false)
        let quit = Task {
            await service.waitForMaintenance()
            waited.set(true)
        }
        try await Task.sleep(for: .milliseconds(50))
        #expect(!waited.current)
        release.open()
        let restored = await restore.value
        await quit.value
        #expect(restored["success"] == .bool(true))
        #expect(waited.current)
        // Nothing running: the wait returns at once.
        await service.waitForMaintenance()
    }
}

/// A lock-guarded flag, set from a task and read from the test.
final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Bool

    init(_ value: Bool) {
        self.value = value
    }

    var current: Bool { lock.withLock { value } }
    func set(_ next: Bool) { lock.withLock { value = next } }
}
