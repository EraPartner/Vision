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

        let failing = BackupPassphrase.set("phrase", store: InMemoryPassphraseStore(failsWrites: true))
        #expect(failing == PassphraseUpdateResult(success: false, available: false, error: BackupPassphrase.unavailableMessage))
        #expect(
            failing.jsonValue
                == .object([
                    "success": .bool(false), "available": .bool(false),
                    "error": .string("OS secure storage is not available on this device."),
                ]))
        let missing = BackupPassphrase.set("phrase", store: nil)
        #expect(!missing.success)
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
    @Test func picksTheHighestRevision() {
        #expect(BackupRestore.pickHighestRevision(["0129_a", "0130_b\n", "0013_c"]) == "0130_b")
        #expect(BackupRestore.pickHighestRevision(["0130_a", "0130_b"]) == "0130_b")
        #expect(BackupRestore.pickHighestRevision(["abc", "0002_x"]) == "0002_x")
        #expect(BackupRestore.pickHighestRevision([]) == "")
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

    @Test func readsTheSchemaHeadOfAPlainDump() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(
            directory + "/copy.sql",
            Array("SET x = 1;\r\nCOPY public.alembic_version (version_num) FROM stdin;\r\n0130_head\r\n\\.\r\n".utf8))
        try writeBytes(
            directory + "/insert.sql",
            Array("-- dump\nINSERT INTO public.alembic_version (version_num) VALUES ('0042_x');\n".utf8))
        try writeBytes(directory + "/none.sql", Array("SELECT 1;".utf8))
        #expect(BackupRestore.readDumpSchemaHead(directory + "/copy.sql") == "0130_head")
        #expect(BackupRestore.readDumpSchemaHead(directory + "/insert.sql") == "0042_x")
        #expect(BackupRestore.readDumpSchemaHead(directory + "/none.sql") == "")
        #expect(BackupRestore.readDumpSchemaHead(directory + "/missing.sql") == "")
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

    @Test func replacingAMissingTreeHasNothingToRollBack() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try makeTree(directory + "/restored", ["a.txt": "a"])
        let token = try DirectorySwitch.replace(
            source: directory + "/restored", destination: directory + "/attachments", preservePrevious: true,
            nonce: "n")
        #expect(token.previousDirectory == nil)
        let result = try DirectorySwitch.rollback(token, nonce: "r")
        #expect(result == .nothingToRollback)
        let finalized = try DirectorySwitch.finalize(token)
        #expect(!finalized)
    }

    @Test func exportCopiesOrCreatesAnEmptyTree() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try makeTree(directory + "/live", ["x/y.txt": "y"])
        try DirectorySwitch.export(directory + "/live", to: directory + "/copy")
        #expect(BackupFiles.exists(directory + "/copy/x/y.txt"))
        try DirectorySwitch.export(directory + "/none", to: directory + "/empty")
        #expect(BackupFiles.isDirectory(directory + "/empty"))
        let names = try FileManager.default.contentsOfDirectory(atPath: directory + "/empty")
        #expect(names.isEmpty)
    }
}
