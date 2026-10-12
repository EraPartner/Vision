import CommonCrypto
import CryptoKit
import Foundation
import Testing
@testable import VisionNativeCore

// The backup key derivation and ciphers against RFC 7914 and vectors produced by Node's
// `crypto` (the implementation Electron Vision uses).

func bytes(hex: String) -> [UInt8] {
    var result: [UInt8] = []
    var index = hex.startIndex
    while index < hex.endIndex {
        let next = hex.index(index, offsetBy: 2)
        result.append(UInt8(hex[index..<next], radix: 16)!)
        index = next
    }
    return result
}

func makeBackupScratchDirectory() throws -> String {
    let path = FileManager.default.temporaryDirectory
        .appendingPathComponent("vision-native-backup-\(UUID().uuidString)", isDirectory: true).path
    try FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
    return path
}

func writeBytes(_ path: String, _ content: [UInt8]) throws {
    try Data(content).write(to: URL(fileURLWithPath: path))
}

func readBytes(_ path: String) throws -> [UInt8] {
    [UInt8](try Data(contentsOf: URL(fileURLWithPath: path)))
}

@Suite struct ScryptTests {
    @Test func rfc7914FirstVector() throws {
        let key = try Scrypt.derive(
            password: [], salt: [], parameters: Scrypt.Parameters(n: 16, r: 1, p: 1), length: 64)
        #expect(
            key.hexString
                == "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906"
        )
    }

    @Test func rfc7914SecondVector() throws {
        let key = try Scrypt.derive(
            password: Array("password".utf8), salt: Array("NaCl".utf8),
            parameters: Scrypt.Parameters(n: 1024, r: 8, p: 16), length: 64)
        #expect(
            key.hexString
                == "fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640"
        )
    }

    @Test func rfc7914ThirdVectorUsesTheLegacyCost() throws {
        let key = try Scrypt.derive(
            password: Array("pleaseletmein".utf8), salt: Array("SodiumChloride".utf8), parameters: Scrypt.legacy,
            length: 64)
        #expect(
            key.hexString
                == "7023bdcb3afd7348461c06cd81fd38ebfda8fbba904f8e3ea9b543f6545da1f2d5432955613f0fcf62d49705242a9af9e61e85dc0d651e40dfcf017b45575887"
        )
    }

    @Test func pbkdf2MatchesRfc7914() {
        let key = Scrypt.pbkdf2SHA256(password: Array("passwd".utf8), salt: Array("salt".utf8), iterations: 1, length: 64)
        #expect(
            key.hexString
                == "55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783"
        )
    }

    @Test func invalidCostIsRejected() {
        #expect(throws: (any Error).self) {
            _ = try Scrypt.derive(password: [1], salt: [1], parameters: Scrypt.Parameters(n: 15, r: 1, p: 1), length: 32)
        }
    }
}

@Suite struct AESGCMStreamTests {
    private let key = (0..<32).map { UInt8($0 &* 7 &+ 3) }
    private let nonce = (0..<12).map { UInt8($0 &* 11 &+ 1) }

    private func message(_ count: Int) -> [UInt8] {
        (0..<count).map { UInt8(truncatingIfNeeded: $0 &* 31 &+ ($0 >> 8)) }
    }

    @Test(arguments: [0, 1, 15, 16, 17, 31, 32, 33, 1000, 65_536 + 5])
    func matchesCryptoKit(length: Int) throws {
        let plaintext = message(length)
        let sealed = try AES.GCM.seal(
            plaintext, using: SymmetricKey(data: key), nonce: try AES.GCM.Nonce(data: nonce))
        let stream = try AESGCMStream(key: key, nonce: nonce, encrypting: true)
        let ciphertext = try stream.process(plaintext)
        let tag = stream.tag()
        #expect(ciphertext == [UInt8](sealed.ciphertext))
        #expect(tag == [UInt8](sealed.tag))
    }

    @Test(arguments: [1, 5, 16, 23, 4096])
    func chunkingDoesNotChangeTheOutput(split: Int) throws {
        let plaintext = message(10_000)
        let whole = try AESGCMStream(key: key, nonce: nonce, encrypting: true)
        let expected = try whole.process(plaintext)
        let expectedTag = whole.tag()

        let pieces = try AESGCMStream(key: key, nonce: nonce, encrypting: true)
        var output: [UInt8] = []
        var index = 0
        var size = split
        while index < plaintext.count {
            let end = min(plaintext.count, index + size)
            output += try pieces.process(Array(plaintext[index..<end]))
            index = end
            size = size == split ? split * 3 + 1 : split
        }
        #expect(output == expected)
        #expect(pieces.tag() == expectedTag)

        let decrypt = try AESGCMStream(key: key, nonce: nonce, encrypting: false)
        let decrypted = try decrypt.process(expected)
        #expect(decrypted == plaintext)
        #expect(decrypt.tag() == expectedTag)
    }
}

@Suite struct EncryptedFileTests {
    private static let nodeV2 =
        "564953494f4e42414b320707070707070707070707070707070709090909090909090909090964ca75cea82eed8dc781f6f9b8d1a951264cf9abc97f862e7e857d343c66c287a7abf5"
    private static let nodeV1Body =
        "000102030405060708090a0b0c0d0e0feadec6da7605257ad54bc18534f7b4b5d2bf435c347e624759f4d8e2c1cc4e8d"

    @Test func decryptsANodeV2Bundle() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let source = directory + "/node.visionbak.enc"
        try writeBytes(source, bytes(hex: Self.nodeV2))
        #expect(BackupBundle.isEncrypted(source))
        try EncryptedFile.decrypt(
            encryptedPath: source, destinationPath: directory + "/plain", passphrase: "node-pass",
            format: BackupBundle.format)
        let plain = try readBytes(directory + "/plain")
        #expect(plain == Array("hello from node v2\n".utf8))
    }

    @Test func writesTheSameBytesAsNodeForTheSameSaltAndNonce() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(directory + "/plain", Array("hello from node v2\n".utf8))
        try EncryptedFile.encryptV2(
            source: directory + "/plain", destination: directory + "/out.enc", passphrase: "node-pass",
            magic: BackupBundle.encryptedMagicV2,
            randomBytes: { count in [UInt8](repeating: count == 16 ? 0x07 : 0x09, count: count) })
        let written = try readBytes(directory + "/out.enc")
        #expect(written.hexString == Self.nodeV2)
        #expect(BackupFiles.size(directory + "/out.enc") != nil)
    }

    @Test func decryptsNodeV1BundleAndLegacySqlFiles() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let bundle = directory + "/legacy.visionbak.enc"
        let sql = directory + "/legacy.sql.enc"
        try writeBytes(bundle, Array("VISIONBAK1".utf8) + bytes(hex: Self.nodeV1Body))
        try writeBytes(sql, Array("VISIONENC1".utf8) + bytes(hex: Self.nodeV1Body))
        #expect(BackupBundle.isEncrypted(bundle))
        #expect(LegacySQLBackup.isEncrypted(sql))
        #expect(!LegacySQLBackup.isEncrypted(bundle))

        try EncryptedFile.decrypt(
            encryptedPath: bundle, destinationPath: directory + "/bundle.out", passphrase: "legacy-pass",
            format: BackupBundle.format)
        try EncryptedFile.decrypt(
            encryptedPath: sql, destinationPath: directory + "/sql.out", passphrase: "legacy-pass",
            format: LegacySQLBackup.format)
        let expected = Array("-- legacy v1\nSELECT 1;\n".utf8)
        let bundlePlain = try readBytes(directory + "/bundle.out")
        let sqlPlain = try readBytes(directory + "/sql.out")
        #expect(bundlePlain == expected)
        #expect(sqlPlain == expected)
    }

    @Test func aWrongPassphraseReportsTheFormatsInvalidErrorAndLeavesNoOutput() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(directory + "/v2.enc", bytes(hex: Self.nodeV2))
        try writeBytes(directory + "/v1.enc", Array("VISIONENC1".utf8) + bytes(hex: Self.nodeV1Body))

        #expect(throws: BackupFailure(BackupBundle.format.invalidError)) {
            try EncryptedFile.decrypt(
                encryptedPath: directory + "/v2.enc", destinationPath: directory + "/v2.out", passphrase: "wrong",
                format: BackupBundle.format)
        }
        #expect(!BackupFiles.exists(directory + "/v2.out"))
        #expect(throws: BackupFailure(BackupPassphrase.invalid)) {
            try EncryptedFile.decrypt(
                encryptedPath: directory + "/v1.enc", destinationPath: directory + "/v1.out", passphrase: "wrong",
                format: LegacySQLBackup.format)
        }
        #expect(!BackupFiles.exists(directory + "/v1.out"))
    }

    @Test func aMissingPassphraseOrUnknownMagicIsReported() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        try writeBytes(directory + "/v2.enc", bytes(hex: Self.nodeV2))
        try writeBytes(directory + "/other", Array("NOTVISION!plus some more bytes".utf8))
        #expect(throws: BackupFailure(BackupPassphrase.required)) {
            try EncryptedFile.decrypt(
                encryptedPath: directory + "/v2.enc", destinationPath: directory + "/out", passphrase: nil,
                format: LegacySQLBackup.format)
        }
        #expect(throws: BackupFailure(LegacySQLBackup.format.unsupportedFormatMessage)) {
            try EncryptedFile.decrypt(
                encryptedPath: directory + "/other", destinationPath: directory + "/out", passphrase: "x",
                format: LegacySQLBackup.format)
        }
    }

    @Test func aTamperedCiphertextFailsAuthentication() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        var tampered = bytes(hex: Self.nodeV2)
        tampered[40] ^= 0x01
        try writeBytes(directory + "/v2.enc", tampered)
        #expect(throws: BackupFailure(BackupBundle.format.invalidError)) {
            try EncryptedFile.decrypt(
                encryptedPath: directory + "/v2.enc", destinationPath: directory + "/out", passphrase: "node-pass",
                format: BackupBundle.format)
        }
        #expect(!BackupFiles.exists(directory + "/out"))
    }

    @Test func roundTripsAMultiChunkFile() throws {
        let directory = try makeBackupScratchDirectory()
        defer { try? FileManager.default.removeItem(atPath: directory) }
        let content = (0..<(BackupFiles.chunkSize * 2 + 123)).map { UInt8(truncatingIfNeeded: $0 &* 13) }
        try writeBytes(directory + "/plain", content)
        try EncryptedFile.encryptV2(
            source: directory + "/plain", destination: directory + "/enc", passphrase: "round trip",
            magic: BackupBundle.encryptedMagicV2)
        try EncryptedFile.decrypt(
            encryptedPath: directory + "/enc", destinationPath: directory + "/out", passphrase: "round trip",
            format: BackupBundle.format)
        let decrypted = try readBytes(directory + "/out")
        #expect(decrypted == content)
        #expect(BackupFiles.size(directory + "/enc") == UInt64(content.count + 10 + 16 + 12 + 16))
    }
}
