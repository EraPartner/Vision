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
    private var dumpGate: (entered: Latch, release: Latch)?

    init(head: String = "0130_head", startFailures: Int = 0) {
        self.head = head
        self.startFailures = startFailures
    }

    func holdDump(entered: Latch, release: Latch) {
        dumpGate = (entered, release)
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

    func schemaHead() async throws -> String { head }

    func activateRestoredDatabase(_ path: String, format: RestoreFormat, expectedSchemaHead: String) async throws
        -> DatabaseSwitchToken
    {
        calls.append("activate:\(format.rawValue):\(expectedSchemaHead)")
        restoredDump = try String(contentsOfFile: path, encoding: .utf8)
        return DatabaseSwitchToken(
            version: 1, liveDatabase: "vision", previousDatabase: "vision_previous", activatedDatabase: "vision",
            activatedAt: "2025-10-09T08:53:20.123Z")
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
        storedPassphrase: String? = nil, runtimeAvailable: Bool = true
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
            now: { Date(timeIntervalSince1970: 1_760_000_000.123) })
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
        #expect(fixture.service.isEncrypted(file))

        let restored = await fixture.service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(
            restored
                == .object([
                    "success": .bool(true), "file": .string(file), "frontendState": .object(["keys": .object([:])]),
                ]))
        let calls = await fixture.runtime.calls
        #expect(
            calls == [
                "dump", "export", "activate:plain:0130_head", "replaceAttachments", "start", "finalizeDatabase",
                "finalizeAttachments",
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
        let fixture = try ServiceFixture(runtime: FakeBackupRuntime(startFailures: 2))
        defer { fixture.remove() }
        let backup = await fixture.service.runBackup(destination: fixture.backups, frontendStateJson: nil)
        let file = try #require(backup["file"]?.stringValue)
        let result = await fixture.service.restore(path: file, passphrase: nil, confirm: { true })
        #expect(result == .object(["success": .bool(false), "error": .string("Error: backend did not become ready")]))
        let calls = await fixture.runtime.calls
        #expect(
            Array(calls.dropFirst(2)) == [
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
        #expect(!fixture.service.isEncrypted(path))
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
        await quit.value
        #expect(firstResult["success"] == .bool(true))
        let calls = await runtime.calls
        #expect(calls.filter { $0 == "dump" }.count == 1)
    }

    @Test func theQuitBackupFollowsTheEffectiveSettings() async throws {
        let fixture = try ServiceFixture()
        defer { fixture.remove() }
        await fixture.service.runQuitBackup(
            rawSettings: .object(["backupDir": .string(fixture.backups), "backupOnQuit": .bool(false)]))
        await fixture.service.runQuitBackup(rawSettings: nil)
        let before = await fixture.runtime.calls
        #expect(before.isEmpty)

        await fixture.service.runQuitBackup(
            rawSettings: .object(["backupDir": .string(fixture.backups), "backupOnQuit": .bool(true)]))
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
}
