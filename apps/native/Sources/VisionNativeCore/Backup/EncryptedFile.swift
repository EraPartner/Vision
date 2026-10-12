import CommonCrypto
import Foundation

/// The two encrypted formats of `packaging/electron/backup/encrypted-file.ts`:
///
///     v1 (legacy, read only)  magic(10) | iv(16) | AES-256-CBC(PKCS#7) ciphertext
///                             key = scrypt(passphrase, <static salt>, N=2^14, r=8, p=1)
///     v2                      magic(10) | salt(16) | nonce(12) | AES-256-GCM ciphertext | tag(16)
///                             key = scrypt(passphrase, salt, N=2^15, r=8, p=1)
///
/// The magic is 10 ASCII bytes (`VISIONBAK1`/`VISIONBAK2` for bundles, `VISIONENC1`/
/// `VISIONENC2` for legacy SQL dumps).
public enum EncryptedFile {
    public static let v1IVBytes = 16
    public static let v2SaltBytes = 16
    public static let v2IVBytes = 12
    public static let v2TagBytes = 16

    /// `DecryptFileOptions` without the paths and the key.
    public struct Format: Sendable, Equatable {
        public let v1Magic: [UInt8]
        public let v2Magic: [UInt8]
        public let v1Salt: String
        public let requiredError: String
        public let invalidError: String
        public let invalidHeaderMessage: String
        public let unsupportedFormatMessage: String

        public init(
            v1Magic: [UInt8], v2Magic: [UInt8], v1Salt: String, requiredError: String, invalidError: String,
            invalidHeaderMessage: String, unsupportedFormatMessage: String
        ) {
            self.v1Magic = v1Magic
            self.v2Magic = v2Magic
            self.v1Salt = v1Salt
            self.requiredError = requiredError
            self.invalidError = invalidError
            self.invalidHeaderMessage = invalidHeaderMessage
            self.unsupportedFormatMessage = unsupportedFormatMessage
        }
    }

    /// `deriveKeyV1`: `nil` for an empty passphrase.
    public static func deriveKeyV1(_ passphrase: String?, salt: String) throws -> [UInt8]? {
        guard let passphrase, !passphrase.isEmpty else { return nil }
        return try Scrypt.derive(
            password: Array(passphrase.utf8), salt: Array(salt.utf8), parameters: Scrypt.legacy, length: 32)
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

    /// `decryptFile`: v1 (CBC) or v2 (GCM) by magic. Plaintext is streamed to `destination`
    /// and removed again when authentication or padding fails, which reports `invalidError`.
    public static func decrypt(
        encryptedPath: String, destinationPath: String, passphrase: String?, format: Format
    ) throws {
        guard let passphrase, !passphrase.isEmpty else { throw BackupFailure(format.requiredError) }
        let input = try BackupFiles.openForReading(encryptedPath)
        defer { try? input.close() }
        let magic = try BackupFiles.read(
            input, at: 0, count: format.v1Magic.count, message: format.invalidHeaderMessage)
        if magic == format.v1Magic {
            try decryptV1(input, destinationPath: destinationPath, passphrase: passphrase, format: format)
        } else if magic == format.v2Magic {
            try decryptV2(input, destinationPath: destinationPath, passphrase: passphrase, format: format)
        } else {
            throw BackupFailure(format.unsupportedFormatMessage)
        }
    }

    private static func decryptV1(
        _ input: FileHandle, destinationPath: String, passphrase: String, format: Format
    ) throws {
        let iv = try BackupFiles.read(
            input, at: UInt64(format.v1Magic.count), count: v1IVBytes, message: format.invalidHeaderMessage)
        guard var key = try deriveKeyV1(passphrase, salt: format.v1Salt) else {
            throw BackupFailure(format.requiredError)
        }
        defer { key.withUnsafeMutableBufferPointer { $0.update(repeating: 0) } }
        // CBC without CommonCrypto's padding: its PKCS#7 removal does not reliably report a
        // bad pad, so the last block is held back and checked here like OpenSSL's
        // `decipher.final()` ("bad decrypt", "wrong final block length").
        let cryptor = try AESCryptor(operation: kCCDecrypt, key: key, iv: iv, options: 0)
        let output = try BackupFiles.createFile(destinationPath)
        do {
            defer { try? output.close() }
            var held: [UInt8] = []
            var ciphertextBytes = 0
            while true {
                let chunk = try BackupFiles.read(input, upTo: BackupFiles.chunkSize)
                if chunk.isEmpty { break }
                ciphertextBytes += chunk.count
                held += try cryptor.update([UInt8](chunk))
                if held.count > kCCBlockSizeAES128 {
                    let ready = held.count - kCCBlockSizeAES128
                    try output.write(contentsOf: Array(held[..<ready]))
                    held.removeFirst(ready)
                }
            }
            guard ciphertextBytes > 0, ciphertextBytes % kCCBlockSizeAES128 == 0 else {
                throw AESCryptorError(status: CCCryptorStatus(kCCAlignmentError))
            }
            held += try cryptor.finish()
            guard let plaintext = pkcs7Unpad(held) else {
                throw AESCryptorError(status: CCCryptorStatus(kCCDecodeError))
            }
            try output.write(contentsOf: plaintext)
        } catch is AESCryptorError {
            // Bad padding or length: the wrong passphrase ("bad decrypt" / "wrong final block length").
            BackupFiles.remove(destinationPath)
            throw BackupFailure(format.invalidError)
        } catch {
            BackupFiles.remove(destinationPath)
            throw error
        }
    }

    /// Removes PKCS#7 padding from the final block; `nil` when the padding is invalid.
    static func pkcs7Unpad(_ block: [UInt8]) -> [UInt8]? {
        guard block.count == kCCBlockSizeAES128, let last = block.last else { return nil }
        let pad = Int(last)
        guard pad >= 1, pad <= kCCBlockSizeAES128 else { return nil }
        var difference: UInt8 = 0
        for byte in block.suffix(pad) { difference |= byte ^ last }
        guard difference == 0 else { return nil }
        return Array(block.prefix(block.count - pad))
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
