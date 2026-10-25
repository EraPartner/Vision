import Foundation
import Testing
@testable import VisionNativeCore

// Passphrase lifecycle, device id, retention, schema checks and the attachment switch.

final class InMemoryPassphraseStore: PassphraseStore, @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?
    private let failsWrites: Bool

    init(_ value: String? = nil, failsWrites: Bool = false) {
        self.value = value
        self.failsWrites = failsWrites
    }

    var stored: String? { lock.withLock { value } }

    func read() throws -> String? { lock.withLock { value } }

    func write(_ passphrase: String) throws {
        if failsWrites { throw KeychainError(status: -25_291) }
        lock.withLock { value = passphrase }
    }

    func delete() throws {
        lock.withLock { value = nil }
    }

    func contains() -> Bool { lock.withLock { value != nil } }
}

final class StringBox: @unchecked Sendable {
    private let lock = NSLock()
    private var items: [String] = []

    func append(_ item: String) { lock.withLock { items.append(item) } }
    var values: [String] { lock.withLock { items } }
}

@Suite struct BackupPassphraseTests {
    @Test func theEnvironmentWinsOverTheStore() {
        let store = InMemoryPassphraseStore("stored")
        #expect(BackupPassphrase.resolve(environment: ["VISION_BACKUP_PASSPHRASE": "env"], store: store) == "env")
        #expect(BackupPassphrase.resolve(environment: ["VISION_BACKUP_PASSPHRASE": ""], store: store) == "stored")
        #expect(BackupPassphrase.resolve(environment: [:], store: InMemoryPassphraseStore()) == nil)
        #expect(BackupPassphrase.resolve(environment: [:], store: nil) == nil)
    }

    @Test func statusReportsBothSources() {
        let status = BackupPassphrase.status(
            environment: ["VISION_BACKUP_PASSPHRASE": "env"], store: InMemoryPassphraseStore())
        #expect(status == PassphraseStatus(hasEnvPassphrase: true, hasStoredPassphrase: false, secureStorageAvailable: true))
        #expect(
            status.jsonValue
                == .object([
                    "success": .bool(true), "hasEnvPassphrase": .bool(true), "hasStoredPassphrase": .bool(false),
                    "secureStorageAvailable": .bool(true),
                ]))
        let unavailable = BackupPassphrase.status(environment: [:], store: nil)
        #expect(!unavailable.secureStorageAvailable)
    }

    @Test func settingStoresClearsOrReportsUnavailable() {
        let store = InMemoryPassphraseStore()
        #expect(BackupPassphrase.set("phrase", store: store) == PassphraseUpdateResult(success: true, available: true))
        #expect(store.stored == "phrase")
        #expect(BackupPassphrase.set("", store: store) == PassphraseUpdateResult(success: true, available: true))
        #expect(store.stored == nil)

        // Electron: a store that exists but fails reports `available: true` and `String(err)`.
        let failing = BackupPassphrase.set("phrase", store: InMemoryPassphraseStore(failsWrites: true))
        #expect(!failing.success)
        #expect(failing.available)
        #expect(failing.error?.hasPrefix("Error: Keychain: ") == true)
        let missing = BackupPassphrase.set("phrase", store: nil)
        #expect(missing == PassphraseUpdateResult(success: false, available: false, error: BackupPassphrase.unavailableMessage))
        #expect(
            missing.jsonValue
                == .object([
                    "success": .bool(false), "available": .bool(false),
                    "error": .string("OS secure storage is not available on this device."),
                ]))
        let clearedWithoutStore = BackupPassphrase.set("", store: nil)
        #expect(clearedWithoutStore == PassphraseUpdateResult(success: true, available: true))
    }
}

@Suite struct BackupDeviceTests {
    @Test func theDeviceIdHashesPlatformArchitectureHostAndUserData() {
        let id = BackupDevice.deviceId(
            platform: "darwin", architecture: "arm64", hostname: "host",
            userData: "/Users/a/Library/Application Support/Vision")
        #expect(id == "61456dd7")
    }

    @Test func aStoredDeviceIdIsKeptAndANewOneIsPersisted() async throws {
        let persisted = StringBox()
        let kept = try await BackupDevice.resolveDeviceId(
            settings: ["backupDeviceId": .string("cafebabe")], userData: "/u", persist: { persisted.append($0) })
        #expect(kept == "cafebabe")
        #expect(persisted.values.isEmpty)

        let fresh = try await BackupDevice.resolveDeviceId(settings: [:], userData: "/u", persist: { persisted.append($0) })
        #expect(fresh.count == 8)
        #expect(persisted.values == [fresh])
    }

    @Test func theICloudDefaultNeedsICloudDrive() {
        let root = "/Users/a/Library/Mobile Documents/com~apple~CloudDocs"
        let present = BackupDevice.defaultICloudBackupDirectory(
            homeDirectory: "/Users/a", appName: "Vision Native", fileExists: { $0 == root })
        #expect(present == root + "/Vision Native/Backups")
        let absent = BackupDevice.defaultICloudBackupDirectory(
            homeDirectory: "/Users/a", appName: "Vision Native", fileExists: { _ in false })
        #expect(absent == "")
    }
}

@Suite struct BackupRetentionTests {
    private func touch(_ path: String, _ date: Date) throws {
        try writeBytes(path, [0x31])
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: path)
    }

    @Test func keepsTheNewestSevenAndRespectsTheGraceWindow() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        let suffixes = [".visionbak", ".visionbak.enc", ".sql", ".sql.enc"]
        for index in 0..<9 {
            try touch(
                directory + "/vision_backup_dev_old\(index)\(suffixes[index % 4])",
                now.addingTimeInterval(-3600 - Double(index) * 60))
        }
        try touch(directory + "/vision_backup_dev_fresh.visionbak", now.addingTimeInterval(-30))
        try touch(directory + "/vision_backup_other_old.visionbak", now.addingTimeInterval(-90_000))
        try touch(directory + "/vision_backup_dev_old.visionbak.partial", now.addingTimeInterval(-3600))
        try touch(directory + "/vision_backup_dev_new.visionbak.partial", now.addingTimeInterval(-60))
        try touch(directory + "/vision_backup_dev_notes.txt", now.addingTimeInterval(-90_000))

        let removed = BackupRetention.cleanup(directory: directory, deviceId: "dev", now: now)
        #expect(removed == 4)
        let left = Set(try FileManager.default.contentsOfDirectory(atPath: directory))
        #expect(left.contains("vision_backup_dev_fresh.visionbak"))
        #expect((0..<6).allSatisfy { left.contains("vision_backup_dev_old\($0)\(suffixes[$0 % 4])") })
        #expect(!left.contains("vision_backup_dev_old6\(suffixes[2])"))
        #expect(!left.contains("vision_backup_dev_old8\(suffixes[0])"))
        #expect(left.contains("vision_backup_other_old.visionbak"))
        #expect(!left.contains("vision_backup_dev_old.visionbak.partial"))
        #expect(left.contains("vision_backup_dev_new.visionbak.partial"))
        #expect(left.contains("vision_backup_dev_notes.txt"))
    }

    @Test func backupsBeyondTheKeepCountInsideTheGraceWindowStay() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let now = Date(timeIntervalSince1970: 1_760_000_000)
        for index in 0..<9 {
            try touch(directory + "/vision_backup_dev_\(index).visionbak", now.addingTimeInterval(-Double(index) * 10))
        }
        #expect(BackupRetention.cleanup(directory: directory, deviceId: "dev", now: now) == 0)
        #expect(BackupRetention.cleanup(directory: directory + "/missing", deviceId: "dev", now: now) == 0)
    }
}

@Suite struct BackupSchemaTests {
    @Test func migrationNamesNeedANumberAndAnUnderscore() {
        #expect(BackupRestore.revisionNumericPrefix("0130_b") == 130)
        #expect(BackupRestore.revisionNumericPrefix("0004_remove_audit_history") == 4)
        #expect(BackupRestore.revisionNumericPrefix("0130") == nil)
        #expect(BackupRestore.revisionNumericPrefix("abc") == nil)
        #expect(BackupRestore.revisionNumericPrefix("") == nil)
    }

    @Test func refusesANewerSchemaOnly() throws {
        try BackupRestore.assertSchemaCompatible("0130_a", current: "0130_b")
        try BackupRestore.assertSchemaCompatible("0129_a", current: "0130_b")
        try BackupRestore.assertSchemaCompatible("fixture_schema", current: "0130_b")
        try BackupRestore.assertSchemaCompatible("0131_a", current: "")
        #expect(
            throws: BackupFailure(
                "BUNDLE_SCHEMA_NEWER: This bundle was created on schema revision \"0131_a\" but this Vision install is at \"0130_b\". Update Vision to a newer version and retry."
            )
        ) {
            try BackupRestore.assertSchemaCompatible("0131_a", current: "0130_b", noun: "bundle")
        }
    }

    @Test func readsTheKyselyLedgerOfAPlainDump() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        // The highest name wins wherever it sits, rows of other tables are not ledger rows,
        // and the dump is scanned to its end (no trailing newline, CRLF line endings).
        try writeBytes(
            directory + "/copy.sql",
            Array(
                ("SET x = 1;\r\nCOPY public.other (id, name) FROM stdin;\r\n1\t0999_not_a_migration\r\n\\.\r\n"
                    + "COPY public.kysely_migration (name, \"timestamp\") FROM stdin;\r\n"
                    + "0002_b\t2026-01-02\r\n0003_c\t2026-01-03\r\n0001_a\t2026-01-01\r\n\\.\r\n"
                    + "COPY public.later (id) FROM stdin;\r\n7\r\n\\.").utf8))
        try writeBytes(
            directory + "/insert.sql",
            Array(
                ("-- dump\nINSERT INTO public.kysely_migration (name, timestamp) VALUES ('0042_x', '2026');\n"
                    + "INSERT INTO kysely_migration VALUES ('0007_y', '2026');\n").utf8))
        try writeBytes(directory + "/none.sql", Array("SELECT 1;\nCOPY public.t (a) FROM stdin;\n0500_z\n\\.\n".utf8))
        try writeBytes(
            directory + "/alembic.sql",
            Array("COPY public.alembic_version (version_num) FROM stdin;\n0130_head\n\\.\n".utf8))
        #expect(try BackupRestore.readDumpSchemaLedger(directory + "/copy.sql") == "0003_c")
        #expect(try BackupRestore.readDumpSchemaLedger(directory + "/insert.sql") == "0042_x")
        #expect(try BackupRestore.readDumpSchemaLedger(directory + "/none.sql") == "")
        #expect(try BackupRestore.readDumpSchemaLedger(directory + "/alembic.sql") == "")
        #expect(throws: (any Error).self) { _ = try BackupRestore.readDumpSchemaLedger(directory + "/missing.sql") }
    }

    @Test func aDumpWithoutTheLedgerPredatesTheBaseline() throws {
        #expect(try BackupRestore.assertPostBaselineBackup("0003_c") == "0003_c")
        let error = #expect(throws: NativeRuntimeError.self) { _ = try BackupRestore.assertPostBaselineBackup("") }
        #expect(error?.code == "BACKUP_PRE_BASELINE")
        #expect(error?.message.hasPrefix("BACKUP_PRE_BASELINE: ") == true)
    }

    @Test func metadataValuesAreStringifiedLikeJavaScript() {
        #expect(BackupRestore.javaScriptString(.string("0130")) == "0130")
        #expect(BackupRestore.javaScriptString(.int(130)) == "130")
        #expect(BackupRestore.javaScriptString(.double(130)) == "130")
        #expect(BackupRestore.javaScriptString(.bool(true)) == "true")
        #expect(BackupRestore.javaScriptString(.object([:])) == "[object Object]")
    }

    @Test func theAllowListResolvesPaths() {
        var allowList = RestorePathAllowList()
        let resolved = allowList.add("/Users/a/Backups/../Backups/x.visionbak")
        #expect(resolved == "/Users/a/Backups/x.visionbak")
        #expect(allowList.contains("/Users/a/Backups/x.visionbak"))
        #expect(!allowList.contains("/Users/a/Backups/y.visionbak"))
    }

    @Test func onlyAPickedAbsolutePathPasses() {
        var allowList = RestorePathAllowList()
        allowList.add("/Users/a/Backups/x.visionbak")
        #expect(allowList.pickedPath("/Users/a/Backups/../Backups/x.visionbak") == "/Users/a/Backups/x.visionbak")
        #expect(allowList.pickedPath("/etc/passwd") == nil)
        #expect(allowList.pickedPath("x.visionbak") == nil)
    }

    @Test func restoreExtensionsAreTheBackupFormats() {
        for name in ["a.visionbak", "a.VISIONBAK.ENC", "a.enc", "a.sql"] {
            #expect(RestorePathAllowList.hasAllowedExtension("/b/" + name), Comment(rawValue: name))
        }
        #expect(!RestorePathAllowList.hasAllowedExtension("/b/a.txt"))
    }
}

@Suite struct DirectorySwitchTests {
    private func makeTree(_ root: String, _ files: [String: String]) throws {
        for (name, content) in files {
            let path = root + "/" + name
            try BackupFiles.createDirectory(PathUtilities.dirname(path))
            try writeBytes(path, Array(content.utf8))
        }
    }

    @Test func fingerprintsAreOrderedAndContentSensitive() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try makeTree(directory + "/a", ["b/2.txt": "two", "1.txt": "one"])
        try makeTree(directory + "/b", ["b/2.txt": "two", "1.txt": "one"])
        try makeTree(directory + "/c", ["b/2.txt": "TWO", "1.txt": "one"])
        let a = try DirectorySwitch.fingerprint(directory + "/a")
        let b = try DirectorySwitch.fingerprint(directory + "/b")
        let c = try DirectorySwitch.fingerprint(directory + "/c")
        #expect(a.entries.map(\.path) == ["1.txt", "b/2.txt"])
        #expect(a.digest == b.digest)
        #expect(a.digest != c.digest)
        let missing = try DirectorySwitch.fingerprint(directory + "/missing")
        #expect(missing.count == 0)
    }

    @Test func replaceRollbackAndFinalize() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let live = directory + "/data/attachments"
        try makeTree(live, ["old.txt": "old"])
        try makeTree(directory + "/restored", ["tx/new.txt": "new"])

        let token = try DirectorySwitch.replace(
            source: directory + "/restored", destination: live, preservePrevious: true, nonce: "n1")
        #expect(token.count == 1)
        #expect(token.previousDirectory == live + ".previous-n1")
        #expect(BackupFiles.exists(live + "/tx/new.txt"))
        #expect(!BackupFiles.exists(live + "/old.txt"))
        #expect(BackupFiles.exists(live + ".previous-n1/old.txt"))
        #expect(!BackupFiles.exists(live + ".staging-n1"))

        let encoded = try JSONEncoder().encode(token)
        let decoded = try JSONDecoder().decode(DirectorySwitchToken.self, from: encoded)
        #expect(decoded == token)

        let result = try DirectorySwitch.rollback(token, nonce: "r1")
        #expect(result == .rolledBack(preservedFailedDirectory: live + ".failed-r1"))
        #expect(BackupFiles.exists(live + "/old.txt"))
        #expect(BackupFiles.exists(live + ".failed-r1/tx/new.txt"))

        let second = try DirectorySwitch.replace(
            source: directory + "/restored", destination: live, preservePrevious: true, nonce: "n2")
        let finalized = try DirectorySwitch.finalize(second)
        #expect(finalized)
        #expect(!BackupFiles.exists(live + ".previous-n2"))
        #expect(BackupFiles.exists(live + "/tx/new.txt"))
    }

    /// Without an old tree the rollback moves the restored tree aside (ADR-207), so the
    /// live directory is absent again, as it was before the switch.
    @Test func replacingAMissingTreeRollsBackToNoTree() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try makeTree(directory + "/restored", ["a.txt": "a"])
        let live = directory + "/attachments"
        let token = try DirectorySwitch.replace(
            source: directory + "/restored", destination: live, preservePrevious: true, nonce: "n")
        #expect(token.previousDirectory == nil)
        let finalized = try DirectorySwitch.finalize(token)
        #expect(!finalized)
        let result = try DirectorySwitch.rollback(token, nonce: "r")
        #expect(result == .rolledBack(preservedFailedDirectory: live + ".failed-r"))
        #expect(!BackupFiles.exists(live))
        #expect(BackupFiles.exists(live + ".failed-r/a.txt"))
    }

    /// restore-journal.test.ts: the journal is written before either rename, and rolling
    /// it back is safe (and repeatable) before, between and after the two renames.
    @Test(arguments: ["before", "between", "after"])
    func theAttachmentJournalRecoversEveryRenameInterruptionRepeatedly(_ phase: String) throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let source = directory + "/source"
        let live = directory + "/attachments"
        try makeTree(source, ["receipt": "new"])
        try makeTree(live, ["receipt": "old"])
        var journal: DirectorySwitchToken?
        #expect(throws: BackupFailure.self) {
            _ = try DirectorySwitch.replace(
                source: source, destination: live, preservePrevious: true, nonce: "n",
                beforeSwitch: { token in
                    journal = token
                    #expect(try readBytes(live + "/receipt") == Array("old".utf8))
                    throw BackupFailure("interrupted after durable intent")
                })
        }
        let token = try #require(journal)
        let previous = try #require(token.previousDirectory)
        if phase != "before" { try DirectorySwitch.move(live, previous) }
        if phase == "after" { try DirectorySwitch.copyTree(source, to: live) }
        _ = try DirectorySwitch.rollback(token, nonce: "r1")
        #expect(try readBytes(live + "/receipt") == Array("old".utf8))
        _ = try DirectorySwitch.rollback(token, nonce: "r2")
        #expect(try readBytes(live + "/receipt") == Array("old".utf8))
    }

    @Test func rollbackFailsClosedWhenBothGenerationsAreMissing() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let token = DirectorySwitchToken(
            count: 0, digest: "", entries: [], previousDirectory: directory + "/attachments.previous-x",
            destinationDirectory: directory + "/attachments")
        #expect(throws: BackupFailure.self) { try DirectorySwitch.rollback(token, nonce: "r") }
    }

    @Test func exportCopiesOrCreatesAnEmptyTree() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try makeTree(directory + "/live", ["x/y.txt": "y"])
        try DirectorySwitch.export(directory + "/live", to: directory + "/copy")
        #expect(BackupFiles.exists(directory + "/copy/x/y.txt"))
        try writeBytes(directory + "/file", Array("x".utf8))
        #expect(throws: BackupFailure("Attachment directory is not a directory: \(directory)/file")) {
            try DirectorySwitch.export(directory + "/file", to: directory + "/refused")
        }
        try DirectorySwitch.export(directory + "/none", to: directory + "/empty")
        #expect(BackupFiles.isDirectory(directory + "/empty"))
        let names = try FileManager.default.contentsOfDirectory(atPath: directory + "/empty")
        #expect(names.isEmpty)
    }
}

@Suite struct BackupFilesTests {
    @Test func regularFileChecksFollowSymlinksLikeElectron() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(directory + "/target.visionbak", Array("x".utf8))
        try FileManager.default.createSymbolicLink(
            atPath: directory + "/link.visionbak", withDestinationPath: directory + "/target.visionbak")
        try BackupFiles.createDirectory(directory + "/folder")
        #expect(BackupFiles.isRegularFile(directory + "/link.visionbak"))
        #expect(!BackupFiles.isRegularFile(directory + "/folder"))
        #expect(!BackupFiles.isRegularFile(directory + "/missing"))
    }
}
