import CommonCrypto
import CryptoKit
import Foundation
import Security

/// Protects the anchor's HMAC key at rest: the `AuditSafeStorage` subset of Electron's
/// `safeStorage` that `audit-anchor.ts` uses (`isEncryptionAvailable`, `encryptString`,
/// `decryptString`). `key.enc` holds the base64 of `encrypt(base64(key))`.
public protocol AuditKeyProtector: Sendable {
    func isAvailable() -> Bool
    func encrypt(_ plaintext: String) throws -> Data
    func decrypt(_ encrypted: Data) throws -> String
}

/// Where Vision Native keeps the AES-256 wrapping key of `key.enc`.
public protocol AuditWrappingKeyStore: Sendable {
    /// The stored 32-byte key, `nil` when there is none; throws when the store is unreadable.
    func load() throws -> Data?
    /// The stored key, created (32 random bytes) on first use.
    func loadOrCreate() throws -> Data
}

/// A generic password in the login Keychain: service `<runtime prefix>.audit-key`,
/// account `audit-anchor-key`, the 32-byte wrapping key as its data.
public struct KeychainAuditWrappingKeyStore: AuditWrappingKeyStore {
    public static let account = "audit-anchor-key"
    public let service: String

    public init(service: String) {
        self.service = service
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    public func load() throws -> Data? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        guard data.count == 32 else { throw AuditAnchorError("key_unavailable") }
        return data
    }

    public func loadOrCreate() throws -> Data {
        if let existing = try load() { return existing }
        let key = try AuditKeyMaterial.randomKey()
        var item = query
        item[kSecValueData as String] = key
        item[kSecAttrLabel as String] = "Vision Native audit key protection"
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem, let raced = try load() { return raced }
        guard status == errSecSuccess else { throw KeychainError(status: status) }
        return key
    }
}

/// Vision Native's replacement for Electron's `safeStorage`: AES-256-GCM under a
/// Keychain-held wrapping key. The ciphertext is versioned with the prefix `vn1`
/// (`vn1 || nonce(12) || ciphertext || tag(16)`), next to Electron's `v10`, so a reader
/// can tell the two encodings apart. A `v10` value (an Electron Vision `key.enc`) is
/// decrypted only when `electronSafeStoragePassword` supplies the Electron app's
/// "Safe Storage" password; phase 1 never does.
public struct NativeAuditKeyProtector: AuditKeyProtector {
    public static let prefix = Data("vn1".utf8)
    private let store: any AuditWrappingKeyStore
    private let electronSafeStoragePassword: (@Sendable () throws -> String?)?

    public init(
        store: any AuditWrappingKeyStore, electronSafeStoragePassword: (@Sendable () throws -> String?)? = nil
    ) {
        self.store = store
        self.electronSafeStoragePassword = electronSafeStoragePassword
    }

    public func isAvailable() -> Bool { true }

    public func encrypt(_ plaintext: String) throws -> Data {
        let key = SymmetricKey(data: try store.loadOrCreate())
        let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: key, nonce: AES.GCM.Nonce())
        var output = Self.prefix
        sealed.nonce.withUnsafeBytes { output.append(contentsOf: $0) }
        output.append(sealed.ciphertext)
        output.append(sealed.tag)
        return output
    }

    public func decrypt(_ encrypted: Data) throws -> String {
        if encrypted.starts(with: ElectronSafeStorage.prefix) {
            guard let password = try electronSafeStoragePassword?() else {
                throw AuditAnchorError("key_unavailable")
            }
            return try ElectronSafeStorage.decrypt(encrypted, password: password)
        }
        guard encrypted.starts(with: Self.prefix), encrypted.count >= Self.prefix.count + 12 + 16,
            let stored = try store.load()
        else {
            throw AuditAnchorError("key_unavailable")
        }
        let body = Data(encrypted.dropFirst(Self.prefix.count))
        let box = try AES.GCM.SealedBox(
            nonce: AES.GCM.Nonce(data: body.prefix(12)), ciphertext: body.dropFirst(12).dropLast(16),
            tag: body.suffix(16))
        let plaintext = try AES.GCM.open(box, using: SymmetricKey(data: stored))
        guard let text = String(data: plaintext, encoding: .utf8) else { throw AuditAnchorError("key_unavailable") }
        return text
    }
}

/// Chromium's macOS `OSCrypt` encoding, which Electron's `safeStorage` uses: `v10` then
/// AES-128-CBC (PKCS#7) with an IV of 16 spaces, under PBKDF2-HMAC-SHA1(password,
/// "saltysalt", 1003 rounds, 16 bytes). The password is the generic password Electron
/// keeps in the login Keychain for the app ("Vision Safe Storage"). Reading an Electron
/// `key.enc` is a phase-4 switch-over step; phase 1 only carries the decoder and its test.
public enum ElectronSafeStorage {
    public static let prefix = Data("v10".utf8)
    static let salt = Array("saltysalt".utf8)
    static let rounds: UInt32 = 1003
    static let iv = [UInt8](repeating: 0x20, count: 16)

    static func derivedKey(_ password: String) throws -> [UInt8] {
        let passwordBytes = Array(password.utf8)
        guard !passwordBytes.isEmpty else { throw AuditAnchorError("key_unavailable") }
        var derived = [UInt8](repeating: 0, count: kCCKeySizeAES128)
        let status = passwordBytes.withUnsafeBufferPointer { passwordBuffer in
            salt.withUnsafeBufferPointer { saltBuffer in
                derived.withUnsafeMutableBufferPointer { output in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        UnsafeRawPointer(passwordBuffer.baseAddress!).assumingMemoryBound(to: CChar.self),
                        passwordBuffer.count, saltBuffer.baseAddress, saltBuffer.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA1), rounds, output.baseAddress, output.count)
                }
            }
        }
        guard status == Int32(kCCSuccess) else { throw AuditAnchorError("key_unavailable") }
        return derived
    }

    static func crypt(_ operation: Int, _ input: [UInt8], key: [UInt8]) throws -> [UInt8] {
        guard !input.isEmpty else { throw AuditAnchorError("key_unavailable") }
        var output = [UInt8](repeating: 0, count: input.count + kCCBlockSizeAES128)
        let capacity = output.count
        var moved = 0
        let status = key.withUnsafeBytes { keyBytes in
            iv.withUnsafeBytes { ivBytes in
                input.withUnsafeBytes { inputBytes in
                    output.withUnsafeMutableBytes { outputBytes in
                        CCCrypt(
                            CCOperation(operation), CCAlgorithm(kCCAlgorithmAES), CCOptions(kCCOptionPKCS7Padding),
                            keyBytes.baseAddress, keyBytes.count, ivBytes.baseAddress, inputBytes.baseAddress,
                            inputBytes.count, outputBytes.baseAddress, capacity, &moved)
                    }
                }
            }
        }
        guard status == CCCryptorStatus(kCCSuccess) else { throw AuditAnchorError("key_unavailable") }
        return Array(output.prefix(moved))
    }

    /// `safeStorage.decryptString` for a `v10` value.
    public static func decrypt(_ encrypted: Data, password: String) throws -> String {
        guard encrypted.starts(with: prefix) else { throw AuditAnchorError("key_unavailable") }
        let plaintext = try crypt(kCCDecrypt, Array(encrypted.dropFirst(prefix.count)), key: try derivedKey(password))
        guard let text = String(bytes: plaintext, encoding: .utf8) else { throw AuditAnchorError("key_unavailable") }
        return text
    }

    /// `safeStorage.encryptString`, for tests and the documented switch-over.
    public static func encrypt(_ plaintext: String, password: String) throws -> Data {
        prefix + Data(try crypt(kCCEncrypt, Array(plaintext.utf8), key: try derivedKey(password)))
    }
}
