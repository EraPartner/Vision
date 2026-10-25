import Foundation

/// The encrypted format of `packaging/electron/backup/encrypted-file.ts`:
///
///     v2  magic(10) | salt(16) | nonce(12) | AES-256-GCM ciphertext | tag(16)
///         key = scrypt(passphrase, salt, N=2^15, r=8, p=1)
///
/// The v1 format (AES-256-CBC, static salt) is retired: its magic is recognised only to
/// refuse it by name (`RETIRED_V1_MESSAGE`). The magic is 10 ASCII bytes (`VISIONBAK1`/
/// `VISIONBAK2` for bundles, `VISIONENC1`/`VISIONENC2` for legacy SQL dumps).
public enum EncryptedFile {
    public static let v2SaltBytes = 16
    public static let v2IVBytes = 12
    public static let v2TagBytes = 16
    /// `RETIRED_V1_MESSAGE`.
    public static let retiredV1Message =
        "This backup uses the retired v1 encryption format, which Vision no longer restores."

    /// `DecryptFileOptions` without the paths and the key.
    public struct Format: Sendable, Equatable {
        /// Magic of the retired v1 format, refused by name.
        public let retiredV1Magic: [UInt8]
        public let v2Magic: [UInt8]
        public let requiredError: String
        public let invalidError: String
        public let invalidHeaderMessage: String
        public let unsupportedFormatMessage: String
        public let retiredFormatMessage: String

        public init(
            retiredV1Magic: [UInt8], v2Magic: [UInt8], requiredError: String, invalidError: String,
            invalidHeaderMessage: String, unsupportedFormatMessage: String,
            retiredFormatMessage: String = EncryptedFile.retiredV1Message
        ) {
            self.retiredV1Magic = retiredV1Magic
            self.v2Magic = v2Magic
            self.requiredError = requiredError
            self.invalidError = invalidError
            self.invalidHeaderMessage = invalidHeaderMessage
            self.unsupportedFormatMessage = unsupportedFormatMessage
            self.retiredFormatMessage = retiredFormatMessage
        }
    }

    /// `deriveKeyV2`: `nil` for an empty passphrase; the salt must be 16 bytes.
    public static func deriveKeyV2(_ passphrase: String?, salt: [UInt8]) throws -> [UInt8]? {
        guard let passphrase, !passphrase.isEmpty else { return nil }
        guard salt.count == v2SaltBytes else { throw BackupFailure("deriveKeyV2 requires a 16-byte salt") }
        return try Scrypt.derive(password: Array(passphrase.utf8), salt: salt, parameters: Scrypt.v2, length: 32)
    }

    /// `isEncryptedFile`: the first bytes equal one of the magics; `false` on any error.
    public static func isEncrypted(_ path: String, magics: [[UInt8]]) -> Bool {
        guard let length = magics.first?.count, length > 0, BackupFiles.isRegularFile(path),
            let handle = try? BackupFiles.openForReading(path)
        else {
            return false
        }
        defer { try? handle.close() }
        guard let data = try? BackupFiles.read(handle, upTo: length), data.count == length else { return false }
        let magic = [UInt8](data)
        return magics.contains(magic)
    }

    /// `encryptFileV2`: a fresh salt and nonce per file; a failure removes the partial output.
    public static func encryptV2(
        source: String, destination: String, passphrase: String, magic: [UInt8],
        randomBytes: (Int) throws -> [UInt8] = BackupFiles.randomBytes
    ) throws {
        guard !passphrase.isEmpty else { throw BackupFailure("Encryption requires a passphrase.") }
        let salt = try randomBytes(v2SaltBytes)
        let nonce = try randomBytes(v2IVBytes)
        guard var key = try deriveKeyV2(passphrase, salt: salt) else {
            throw BackupFailure("Encryption requires a passphrase.")
        }
        defer { key.withUnsafeMutableBufferPointer { $0.update(repeating: 0) } }
        let input = try BackupFiles.openForReading(source)
        defer { try? input.close() }
        let output = try BackupFiles.createFile(destination)
        do {
            defer { try? output.close() }
            let stream = try AESGCMStream(key: key, nonce: nonce, encrypting: true)
            try output.write(contentsOf: magic + salt + nonce)
            while true {
                let chunk = try BackupFiles.read(input, upTo: BackupFiles.chunkSize)
                if chunk.isEmpty { break }
                try output.write(contentsOf: try stream.process([UInt8](chunk)))
            }
            try output.write(contentsOf: stream.tag())
            try output.synchronize()
        } catch {
            BackupFiles.remove(destination)
            throw error
        }
    }

    /// `decryptFile`: the v2 (GCM) format only; the retired v1 magic is refused by name.
    /// Plaintext is streamed to `destination` and removed again when authentication fails,
    /// which reports `invalidError`.
    public static func decrypt(
        encryptedPath: String, destinationPath: String, passphrase: String?, format: Format
    ) throws {
        guard let passphrase, !passphrase.isEmpty else { throw BackupFailure(format.requiredError) }
        let input = try BackupFiles.openForReading(encryptedPath)
        defer { try? input.close() }
        let magic = try BackupFiles.read(
            input, at: 0, count: format.v2Magic.count, message: format.invalidHeaderMessage)
        if magic == format.retiredV1Magic { throw BackupFailure(format.retiredFormatMessage) }
        guard magic == format.v2Magic else { throw BackupFailure(format.unsupportedFormatMessage) }
        try decryptV2(input, destinationPath: destinationPath, passphrase: passphrase, format: format)
    }

    private static func decryptV2(
        _ input: FileHandle, destinationPath: String, passphrase: String, format: Format
    ) throws {
        let headerLength = format.v2Magic.count + v2SaltBytes + v2IVBytes
        let size = try input.seekToEnd()
        guard size >= UInt64(headerLength + v2TagBytes) else { throw BackupFailure(format.invalidHeaderMessage) }
        let header = try BackupFiles.read(input, at: 0, count: headerLength, message: format.invalidHeaderMessage)
        let tag = try BackupFiles.read(
            input, at: size - UInt64(v2TagBytes), count: v2TagBytes, message: format.invalidHeaderMessage)
        let salt = Array(header[format.v2Magic.count..<(format.v2Magic.count + v2SaltBytes)])
        let nonce = Array(header[(format.v2Magic.count + v2SaltBytes)...])
        guard var key = try deriveKeyV2(passphrase, salt: salt) else { throw BackupFailure(format.requiredError) }
        defer { key.withUnsafeMutableBufferPointer { $0.update(repeating: 0) } }
        let stream = try AESGCMStream(key: key, nonce: nonce, encrypting: false)
        var remaining = size - UInt64(headerLength + v2TagBytes)
        try input.seek(toOffset: UInt64(headerLength))
        let output = try BackupFiles.createFile(destinationPath)
        do {
            defer { try? output.close() }
            while remaining > 0 {
                let chunk = try BackupFiles.read(input, upTo: Int(min(UInt64(BackupFiles.chunkSize), remaining)))
                guard !chunk.isEmpty else { throw BackupFailure(format.invalidHeaderMessage) }
                remaining -= UInt64(chunk.count)
                try output.write(contentsOf: try stream.process([UInt8](chunk)))
            }
            guard constantTimeEqual(stream.tag(), tag) else { throw BackupFailure(format.invalidError) }
        } catch {
            BackupFiles.remove(destinationPath)
            throw error
        }
    }
}
