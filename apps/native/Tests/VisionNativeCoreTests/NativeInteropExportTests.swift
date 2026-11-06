import Foundation
import Testing
@testable import VisionNativeCore

// The CI interop gate (ADR-204 phase 1): with VISION_NATIVE_INTEROP_DIR set, this writes
// backup bundles (unencrypted and v2-encrypted) with Vision Native's own code, from
// synthetic data only, so they can be opened with the Electron readers
// (`packaging/electron/backup/bundle.ts`). The bundle's database is a SQLite file whose
// header records the schema version (format 2, ADR-263). Without the variable the test is
// skipped.

enum NativeInterop {
    static let environmentKey = "VISION_NATIVE_INTEROP_DIR"
    /// Synthetic test secret, also in native-interop.test.ts.
    static let passphrase = "vision-native-interop-passphrase"
    static let deviceId = "native-interop"
    static let schemaVersion = 3
    static let appVersion = "0.1.0-interop"
    static let createdAt = Date(timeIntervalSince1970: 1_760_000_000.25)
    static let database = sqliteDatabase(userVersion: schemaVersion, body: "synthetic Vision Native interop fixture")
    static let databaseInfo = BundleDatabaseInfo(
        schemaVersion: schemaVersion, sqliteVersion: "3.43.2", sha256: sha256Hex(database), bytes: database.count)
    static let attachments = ["tx-001/receipt.txt": "SYNTHETIC-RECEIPT", "tx-002/notes/a.txt": "synthetic note é"]
    static let frontendState = JSONValue.object([
        "keys": .object(["vision.language": .string("nl"), "vision.theme": .string("dark")])
    ])

    static var directory: String? { ProcessInfo.processInfo.environment[environmentKey] }
}

@Suite struct NativeInteropExportTests {
    @Test(.enabled(if: NativeInterop.directory != nil)) func writesTheInteropArtifacts() async throws {
        let output = try #require(NativeInterop.directory)
        try BackupFiles.createDirectory(output)
        let work = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: work) }

        let databasePath = work + "/snapshot.sqlite3"
        try writeBytes(databasePath, [UInt8](NativeInterop.database))
        for (relative, content) in NativeInterop.attachments {
            let path = work + "/attachments/" + relative
            try BackupFiles.createDirectory(PathUtilities.dirname(path))
            try writeBytes(path, Array(content.utf8))
        }
        func bundle(into directory: String) throws -> String {
            try BackupFiles.createDirectory(directory)
            return try BackupBundle.create(
                destinationDirectory: directory, deviceId: NativeInterop.deviceId, appVersion: NativeInterop.appVersion,
                databasePath: databasePath, database: NativeInterop.databaseInfo,
                attachmentsDirectory: work + "/attachments", frontendState: NativeInterop.frontendState,
                now: NativeInterop.createdAt)
        }
        let plain = try bundle(into: work + "/plain")
        let plainTarget = output + "/swift-plain.visionbak"
        try? FileManager.default.removeItem(atPath: plainTarget)
        try FileManager.default.moveItem(atPath: plain, toPath: plainTarget)
        let encrypted = try BackupBundle.encrypt(try bundle(into: work + "/encrypted"), passphrase: NativeInterop.passphrase)
        let encryptedTarget = output + "/swift-encrypted.visionbak.enc"
        try? FileManager.default.removeItem(atPath: encryptedTarget)
        try FileManager.default.moveItem(atPath: encrypted, toPath: encryptedTarget)
        // The Swift reader opens both, so a failure here is not an interop finding.
        let reopened = try BackupBundle.open(encryptedTarget, passphrase: NativeInterop.passphrase, temporaryParent: work)
        defer { reopened.cleanup() }
        #expect(try readBytes(reopened.databasePath) == [UInt8](NativeInterop.database))
        #expect(BackupRestore.metadataSchemaVersion(reopened.metadata) == NativeInterop.schemaVersion)
        #expect(BackupRestore.metadataSha256(reopened.metadata) == sha256Hex(NativeInterop.database))

        var attachments: [String: JSONValue] = [:]
        for (relative, content) in NativeInterop.attachments { attachments[relative] = .string(content) }
        let expected = JSONValue.object([
            "bundle": .object([
                "plain": .string("swift-plain.visionbak"), "encrypted": .string("swift-encrypted.visionbak.enc"),
                "passphrase": .string(NativeInterop.passphrase), "deviceId": .string(NativeInterop.deviceId),
                "schemaVersion": .int(NativeInterop.schemaVersion), "appVersion": .string(NativeInterop.appVersion),
                "createdAt": .string(isoTimestamp(NativeInterop.createdAt)),
                "databaseSha256": .string(sha256Hex(NativeInterop.database)),
                "attachments": .object(attachments), "frontendState": NativeInterop.frontendState,
            ]),
        ])
        try expected.serialized().write(to: URL(fileURLWithPath: output + "/expected.json"))
    }
}
