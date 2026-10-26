import Foundation
import Testing
@testable import VisionNativeCore

// Vision backup bundles: the Electron Vision 1.0.2 fixture, the retired v1 (CBC) format
// that is refused by name, and bundles written by Vision Native.

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

/// A bundle from the current Electron writer (the in-repo zip writer of #349).
enum CurrentBackupFixture {
    static let passphrase = "vision-zip-writer-fixture"
    static let sha256 = "3961705002cdfe92a41b9ba92b17b6030c53c711454ac226080930548d47453d"

    static func path() throws -> String {
        guard let path = Bundle.module.path(forResource: "vision-2026-10-zip-writer.visionbak", ofType: "enc") else {
            throw BackupFailure("The current backup fixture is missing from the test resources")
        }
        return path
    }
}

@Suite struct BackupBundleFixtureTests {
    @Test func opensABundleFromTheCurrentElectronWriter() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let path = try CurrentBackupFixture.path()
        #expect(sha256Hex(try Data(contentsOf: URL(fileURLWithPath: path))) == CurrentBackupFixture.sha256)
        let opened = try BackupBundle.open(
            path, passphrase: CurrentBackupFixture.passphrase, temporaryParent: directory)
        defer { opened.cleanup() }

        #expect(opened.metadata["schemaHead"]?.stringValue == "0001_baseline")
        #expect(opened.metadata["appVersion"]?.stringValue == "2026.10-fixture")
        #expect(opened.metadata["deviceId"]?.stringValue == "synthetic-fixture")
        #expect(opened.metadata["createdAt"]?.stringValue == "2026-10-26T09:21:37.739Z")
        #expect(opened.metadata["encrypted"] == .bool(false))
        let dump = try String(contentsOfFile: opened.dbSqlPath, encoding: .utf8)
        #expect(dump.contains("INSERT INTO fixture_probe VALUES (1, 'zip-writer-349');"))
        let attachments = try #require(opened.attachmentsDirectory)
        let receipt = try String(contentsOfFile: attachments + "/tx-002/reçu été.txt", encoding: .utf8)
        #expect(receipt == "SYNTHETIC-RECEIPT")
        #expect(opened.frontendState == .object(["keys": .object(["vision.language": .string("fi")])]))
    }


    @Test func theFixtureIsTheElectronFileByteForByte() throws {
        let path = try BackupFixture.path()
        let data = try Data(contentsOf: URL(fileURLWithPath: path))
        #expect(sha256Hex(data) == BackupFixture.sha256)
        #expect(BackupBundle.isEncrypted(path))
        #expect(!LegacySQLBackup.isEncrypted(path))
    }

    @Test func opensTheVision102Bundle() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let fixturePath = try BackupFixture.path()
        let opened = try BackupBundle.open(fixturePath, passphrase: BackupFixture.passphrase, temporaryParent: directory)
        defer { opened.cleanup() }

        #expect(opened.metadata["schemaHead"]?.stringValue == "fixture_schema")
        #expect(opened.metadata["appVersion"]?.stringValue == "1.0.2")
        #expect(opened.metadata["deviceId"]?.stringValue == "sanitized-fixture")
        #expect(opened.metadata["createdAt"]?.stringValue == "2026-09-08T17:06:33.220Z")
        #expect(opened.metadata["bundleVersion"].map(BackupRestore.javaScriptString) == "1")
        #expect(opened.metadata["encrypted"] == .bool(false))

        let dump = try String(contentsOfFile: opened.dbSqlPath, encoding: .utf8)
        #expect(
            dump
                == "-- sanitized Vision 1.0.2 compatibility fixture\n"
                + "CREATE TABLE fixture_probe (id integer PRIMARY KEY, value text);\n"
                + "INSERT INTO fixture_probe VALUES (1, 'v1.0.2');\n")
        let attachments = try #require(opened.attachmentsDirectory)
        let receipt = try String(contentsOfFile: attachments + "/tx-001/receipt.txt", encoding: .utf8)
        #expect(receipt == "SANITIZED-RECEIPT")
        #expect(opened.frontendState == .object(["keys": .object(["vision.language": .string("nl")])]))
        #expect(opened.temporaryDirectory.hasPrefix(directory + "/vision_restore_"))
        #expect(!BackupFiles.exists(opened.temporaryDirectory + "/bundle.visionbak"))

        opened.cleanup()
        #expect(!BackupFiles.exists(opened.temporaryDirectory))
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
        let json = BackupBundle.metadataJSON(
            schemaHead: "0130_head", appVersion: "1.2.3", deviceId: "dev", createdAt: "2025-10-09T08:53:20.125Z")
        #expect(
            json
                == "{\n  \"bundleVersion\": 1,\n  \"schemaHead\": \"0130_head\",\n  \"appVersion\": \"1.2.3\",\n"
                + "  \"deviceId\": \"dev\",\n  \"createdAt\": \"2025-10-09T08:53:20.125Z\",\n  \"encrypted\": false\n}")
    }

    private func makeSources(_ directory: String) throws -> (dump: String, attachments: String) {
        let dump = directory + "/dump.sql"
        try writeBytes(dump, Array("SELECT 1;\n".utf8))
        let attachments = directory + "/attachments"
        try BackupFiles.createDirectory(attachments + "/tx-1/nested")
        try writeBytes(attachments + "/tx-1/a.pdf", Array("pdf".utf8))
        try writeBytes(attachments + "/tx-1/nested/b.txt", Array("b".utf8))
        return (dump, attachments)
    }

    @Test func createsAndOpensAPlainBundle() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        let state = JSONValue.object(["keys": .object(["vision.theme": .string("dark")])])
        let path = try BackupBundle.create(
            destinationDirectory: directory + "/out", deviceId: "dev12345", schemaHead: "0130_head",
            appVersion: "1.2.3", dbSqlPath: sources.dump, attachmentsDirectory: sources.attachments,
            frontendState: state, now: now)
        #expect(path == directory + "/out/vision_backup_dev12345_2025-10-09_08-53-20.visionbak")
        #expect(!BackupFiles.exists(path + ".partial"))
        #expect(!BackupBundle.isEncrypted(path))

        let reader = try ZipReader(path: path)
        let names = reader.entries.map(\.name)
        reader.close()
        #expect(
            names == [
                "metadata.json", "db.sql", "attachments/tx-1/", "attachments/tx-1/a.pdf", "attachments/tx-1/nested/",
                "attachments/tx-1/nested/b.txt", "frontend-state.json",
            ])

        let opened = try BackupBundle.open(path, passphrase: nil, temporaryParent: directory)
        defer { opened.cleanup() }
        #expect(opened.metadata["schemaHead"]?.stringValue == "0130_head")
        #expect(opened.metadata["deviceId"]?.stringValue == "dev12345")
        #expect(opened.metadata["createdAt"]?.stringValue == "2025-10-09T08:53:20.125Z")
        #expect(opened.frontendState == state)
        let dump = try readBytes(opened.dbSqlPath)
        #expect(dump == Array("SELECT 1;\n".utf8))
        let nested = try readBytes(try #require(opened.attachmentsDirectory) + "/tx-1/nested/b.txt")
        #expect(nested == Array("b".utf8))
    }

    @Test func encryptsAndOpensWithThePassphrase() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let sources = try makeSources(directory)
        let path = try BackupBundle.create(
            destinationDirectory: directory + "/out", deviceId: "dev", schemaHead: nil, appVersion: nil,
            dbSqlPath: sources.dump, attachmentsDirectory: nil, frontendState: nil, now: now)
        let encrypted = try BackupBundle.encrypt(path, passphrase: "secret phrase")
        #expect(encrypted == path + ".enc")
        #expect(!BackupFiles.exists(path))
        #expect(BackupBundle.isEncrypted(encrypted))

        let opened = try BackupBundle.open(encrypted, passphrase: "secret phrase", temporaryParent: directory)
        defer { opened.cleanup() }
        #expect(opened.metadata["schemaHead"]?.stringValue == "")
        #expect(opened.metadata["appVersion"]?.stringValue == "unknown")
        #expect(opened.attachmentsDirectory == nil)
        #expect(opened.frontendState == nil)
    }

    @Test func aBundleWithoutDbSqlIsCorrupt() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let writer = try ZipWriter(path: directory + "/partial.visionbak")
        try writer.addData(name: "metadata.json", data: Data("{}".utf8), modified: now)
        try writer.finish()
        #expect(throws: BackupFailure("Bundle is missing db.sql — file may be corrupt.")) {
            _ = try BackupBundle.open(directory + "/partial.visionbak", passphrase: nil, temporaryParent: directory)
        }
        let other = try ZipWriter(path: directory + "/nometa.visionbak")
        try other.addData(name: "db.sql", data: Data("x".utf8), modified: now)
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
                destinationDirectory: directory + "/out", deviceId: "dev", schemaHead: nil, appVersion: nil,
                dbSqlPath: sources.dump, attachmentsDirectory: sources.attachments, frontendState: nil, now: now)
        }
        let written = try FileManager.default.contentsOfDirectory(atPath: directory + "/out")
        #expect(written.isEmpty)
    }
}
