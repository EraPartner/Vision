import Foundation
import Testing
@testable import VisionNativeCore

// Vision backup bundles: the Electron Vision 1.0.2 fixture (a format 1 bundle with a
// PostgreSQL dump, now refused by its format), the retired v1 (CBC) encryption that is refused
// by name, and format 2 bundles with a SQLite database written by Vision Native.

enum BackupFixture {
    static let passphrase = "vision-v1.0.2-fixture"
    static let sha256 = "096068975bedafbf7ac0e77a2c57ba4ee13bf4bf37b32bca5064fd27e3bbf766"

    static func path() throws -> String {
        guard let path = Bundle.module.path(forResource: "vision-1.0.2-sanitized.visionbak", ofType: "enc") else {
            throw BackupFailure("The backup fixture is missing from the test resources")
        }
        return path
    }
}

@Suite struct BackupBundleFixtureTests {
    @Test func theFixtureIsTheElectronFileByteForByte() throws {
        let path = try BackupFixture.path()
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        #expect(sha256Hex(data) == BackupFixture.sha256)
        #expect(BackupBundle.isEncrypted(path))
        #expect(!EncryptedBackupFile.isEncrypted(path))
    }

    /// ADR-263/265: a format 1 bundle holds a PostgreSQL dump, which this Vision cannot load.
    @Test func theVision102BundleIsRefusedByItsFormat() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let fixturePath = try BackupFixture.path()
        let error = #expect(throws: NativeRuntimeError.self) {
            _ = try BackupBundle.open(fixturePath, passphrase: BackupFixture.passphrase, temporaryParent: directory)
        }
        #expect(
            error
                == NativeRuntimeError(
                    "BACKUP_FORMAT_UNSUPPORTED",
                    "This backup uses backup format 1, which this version of Vision cannot restore."))
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory)
        #expect(leftovers.isEmpty)
    }

    @Test func listsTheFixtureEntriesInArchiveOrder() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let fixturePath = try BackupFixture.path()
        try EncryptedFile.decrypt(
            encryptedPath: fixturePath, destinationPath: directory + "/fixture.zip",
            passphrase: BackupFixture.passphrase, format: BackupBundle.format)
        let reader = try ZipReader(path: directory + "/fixture.zip")
        defer { reader.close() }
        #expect(
            reader.entries.map(\.name) == [
                "metadata.json", "frontend-state.json", "db.sql", "attachments/tx-001/",
                "attachments/tx-001/receipt.txt",
            ])

    }

    @Test func aRetiredV1BundleIsRefusedByName() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        // magic | iv(16) | one CBC block: the header alone decides, the ciphertext is never read.
        let body = [UInt8](repeating: 0x5A, count: 32)
        try writeBytes(directory + "/v1.visionbak.enc", BackupBundle.encryptedMagicV1 + body)
        #expect(BackupBundle.isEncrypted(directory + "/v1.visionbak.enc"))
        #expect(throws: BackupFailure(EncryptedFile.retiredV1Message)) {
            _ = try BackupBundle.open(
                directory + "/v1.visionbak.enc", passphrase: BackupFixture.passphrase, temporaryParent: directory)
        }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory)
        #expect(leftovers == ["v1.visionbak.enc"])
    }

    @Test func aWrongOrMissingPassphraseHasElectronsMessages() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        #expect(throws: BackupFailure("Invalid passphrase: unable to authenticate encrypted bundle.")) {
            _ = try BackupBundle.open(try BackupFixture.path(), passphrase: "not it", temporaryParent: directory)
        }
        #expect(throws: BackupFailure("This bundle is encrypted. Set a backup passphrase to restore it.")) {
            _ = try BackupBundle.open(try BackupFixture.path(), passphrase: nil, temporaryParent: directory)
        }
        let leftovers = try FileManager.default.contentsOfDirectory(atPath: directory)
        #expect(leftovers.isEmpty)
    }
}

@Suite struct BackupBundleTests {
    private let now = Date(timeIntervalSince1970: 1_760_000_000.125)

    @Test func namesFollowElectron() {
        #expect(BackupBundle.fileTimestamp(now) == "2025-10-09_08-53-20")
        #expect(BackupBundle.fileName(deviceId: "abcd1234", date: now) == "vision_backup_abcd1234_2025-10-09_08-53-20.visionbak")
    }

    @Test func metadataIsPrettyPrintedInElectronsOrder() {
        let digest = String(repeating: "ab", count: 32)
        let json = BackupBundle.metadataJSON(
            database: BundleDatabaseInfo(schemaVersion: 3, sqliteVersion: "3.43.2", sha256: digest, bytes: 8192),
            appVersion: "1.2.3", deviceId: "dev", createdAt: "2025-10-09T08:53:20.125Z")
        #expect(
            json
                == "{\n  \"bundleVersion\": 2,\n  \"database\": \"sqlite\",\n  \"schemaVersion\": 3,\n"
                + "  \"sqliteVersion\": \"3.43.2\",\n  \"databaseSha256\": \"\(digest)\",\n  \"databaseBytes\": 8192,\n"
                + "  \"appVersion\": \"1.2.3\",\n  \"deviceId\": \"dev\",\n  \"createdAt\": \"2025-10-09T08:53:20.125Z\",\n"
                + "  \"encrypted\": false\n}")
        let unknown = BackupBundle.metadataJSON(
            database: BundleDatabaseInfo(schemaVersion: 3, sqliteVersion: nil, sha256: nil, bytes: nil),
            appVersion: "1.2.3", deviceId: "dev", createdAt: "x")
        #expect(unknown.contains("\"sqliteVersion\": null,\n  \"databaseSha256\": null,\n  \"databaseBytes\": null,"))
    }

    private static let database = sqliteDatabase(userVersion: 3, body: "snapshot")
    private static let info = BundleDatabaseInfo(
        schemaVersion: 3, sqliteVersion: "3.43.2", sha256: sha256Hex(database), bytes: database.count)

    private func makeSources(_ directory: String) throws -> (database: String, attachments: String) {
        let database = directory + "/snapshot.sqlite3"
        try writeBytes(database, [UInt8](Self.database))
        let attachments = directory + "/attachments"
        try BackupFiles.createDirectory(attachments + "/tx-1/nested")
        try writeBytes(attachments + "/tx-1/a.pdf", Array("pdf".utf8))
        try writeBytes(attachments + "/tx-1/nested/b.txt", Array("b".utf8))
        return (database, attachments)
    }

    @Test func createsAndOpensAPlainBundle() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        let state = JSONValue.object(["keys": .object(["vision.theme": .string("dark")])])
        let path = try BackupBundle.create(
            destinationDirectory: directory + "/out", deviceId: "dev12345", appVersion: "1.2.3",
            databasePath: sources.database, database: Self.info, attachmentsDirectory: sources.attachments,
            frontendState: state, now: now)
        #expect(path == directory + "/out/vision_backup_dev12345_2025-10-09_08-53-20.visionbak")
        #expect(!BackupFiles.exists(path + ".partial"))
        #expect(!BackupBundle.isEncrypted(path))

        let reader = try ZipReader(path: path)
        let names = reader.entries.map(\.name)
        reader.close()
        #expect(
            names == [
                "metadata.json", "db.sqlite3", "attachments/tx-1/", "attachments/tx-1/a.pdf",
                "attachments/tx-1/nested/", "attachments/tx-1/nested/b.txt", "frontend-state.json",
            ])

        let opened = try BackupBundle.open(path, passphrase: nil, temporaryParent: directory)
        defer { opened.cleanup() }
        #expect(opened.metadata["bundleVersion"] == .int(2))
        #expect(opened.metadata["database"] == .string("sqlite"))
        #expect(opened.metadata["schemaVersion"] == .int(3))
        #expect(opened.metadata["databaseSha256"] == .string(sha256Hex(Self.database)))
        #expect(opened.metadata["deviceId"]?.stringValue == "dev12345")
        #expect(opened.metadata["createdAt"]?.stringValue == "2025-10-09T08:53:20.125Z")
        #expect(opened.frontendState == state)
        #expect(try readBytes(opened.databasePath) == [UInt8](Self.database))
        let nested = try readBytes(try #require(opened.attachmentsDirectory) + "/tx-1/nested/b.txt")
        #expect(nested == Array("b".utf8))
    }

    @Test func encryptsAndOpensWithThePassphrase() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        let path = try BackupBundle.create(
            destinationDirectory: directory + "/work", deviceId: "dev", appVersion: nil,
            databasePath: sources.database, database: Self.info, attachmentsDirectory: nil, frontendState: nil,
            now: now)
        let encrypted = try BackupBundle.encrypt(path, passphrase: "secret phrase", destinationDirectory: directory + "/out")
        #expect(encrypted == directory + "/out/vision_backup_dev_2025-10-09_08-53-20.visionbak.enc")
        #expect(!BackupFiles.exists(path))
        #expect(!BackupFiles.exists(encrypted + ".partial"))
        #expect(BackupBundle.isEncrypted(encrypted))

        let opened = try BackupBundle.open(encrypted, passphrase: "secret phrase", temporaryParent: directory)
        defer { opened.cleanup() }
        #expect(opened.metadata["appVersion"]?.stringValue == "unknown")
        #expect(opened.attachmentsDirectory == nil)
        #expect(opened.frontendState == nil)
    }

    @Test func onlyASqliteDatabaseWithASchemaVersionIsBundled() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        try writeBytes(directory + "/dump.sql", Array("SELECT 1;\n".utf8))
        #expect(throws: BackupFailure("The backup database is not a SQLite database file.")) {
            _ = try BackupBundle.create(
                destinationDirectory: directory + "/out", deviceId: "dev", appVersion: nil,
                databasePath: directory + "/dump.sql", database: Self.info, attachmentsDirectory: nil,
                frontendState: nil, now: now)
        }
        #expect(throws: BackupFailure("createBundle requires the database schema version")) {
            _ = try BackupBundle.create(
                destinationDirectory: directory + "/out", deviceId: "dev", appVersion: nil,
                databasePath: sources.database,
                database: BundleDatabaseInfo(schemaVersion: 0, sqliteVersion: nil, sha256: nil, bytes: nil),
                attachmentsDirectory: nil, frontendState: nil, now: now)
        }
        let written = (try? FileManager.default.contentsOfDirectory(atPath: directory + "/out")) ?? []
        #expect(written.isEmpty)
    }

    @Test func aBundleWithoutItsDatabaseIsCorruptOrOfAnOlderFormat() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let writer = try ZipWriter(path: directory + "/partial.visionbak")
        try writer.addData(name: "metadata.json", data: Data(#"{"bundleVersion":2}"#.utf8), modified: now)
        try writer.finish()
        #expect(throws: BackupFailure("Bundle is missing db.sqlite3 — file may be corrupt.")) {
            _ = try BackupBundle.open(directory + "/partial.visionbak", passphrase: nil, temporaryParent: directory)
        }
        let older = try ZipWriter(path: directory + "/older.visionbak")
        try older.addData(name: "metadata.json", data: Data(#"{"bundleVersion":1}"#.utf8), modified: now)
        try older.addData(name: "db.sql", data: Data("SELECT 1;".utf8), modified: now)
        try older.finish()
        let error = #expect(throws: NativeRuntimeError.self) {
            _ = try BackupBundle.open(directory + "/older.visionbak", passphrase: nil, temporaryParent: directory)
        }
        #expect(error?.code == "BACKUP_FORMAT_UNSUPPORTED")
        let other = try ZipWriter(path: directory + "/nometa.visionbak")
        try other.addData(name: "db.sqlite3", data: Self.database, modified: now)
        try other.finish()
        #expect(throws: BackupFailure("Bundle is missing metadata.json — file may be corrupt.")) {
            _ = try BackupBundle.open(directory + "/nometa.visionbak", passphrase: nil, temporaryParent: directory)
        }
    }

    @Test func aSymlinkInTheAttachmentTreeFailsTheBackup() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        try FileManager.default.createSymbolicLink(atPath: sources.attachments + "/link", withDestinationPath: "/etc")
        #expect(throws: BackupFailure("Attachment tree contains a symlink: attachments/link")) {
            _ = try BackupBundle.create(
                destinationDirectory: directory + "/out", deviceId: "dev", appVersion: nil,
                databasePath: sources.database, database: Self.info, attachmentsDirectory: sources.attachments,
                frontendState: nil, now: now)
        }
        let written = try FileManager.default.contentsOfDirectory(atPath: directory + "/out")
        #expect(written.isEmpty)
    }
}
