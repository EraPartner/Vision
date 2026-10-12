import CryptoKit
import Darwin
import Foundation
import Security

/// Where the backup passphrase is kept. Electron encrypts it with `safeStorage` into
/// `settings.json` (`backupPassphraseEncrypted`); Vision Native keeps it in the login
/// Keychain instead and never writes that field.
public protocol PassphraseStore: Sendable {
    /// The stored passphrase, `nil` when there is none; throws when the store is unreadable.
    func read() throws -> String?
    func write(_ passphrase: String) throws
    /// Removes the stored passphrase; a missing one is not an error.
    func delete() throws
    /// Whether a passphrase is stored, without reading its value.
    func contains() -> Bool
}

public struct KeychainError: Error, Equatable, Sendable, LocalizedError {
    public let status: OSStatus

    public var errorDescription: String? {
        let text = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
        return "Keychain: \(text)"
    }
}

/// A generic password in the login Keychain: service
/// `com.vaultvoyager.vision-native.backup-passphrase`, account = the backup device id.
public struct KeychainPassphraseStore: PassphraseStore {
    public static let service = "com.vaultvoyager.vision-native.backup-passphrase"
    public let account: String

    public init(account: String) {
        self.account = account
    }

    private var query: [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: account,
        ]
    }

    public func read() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw KeychainError(status: status) }
        return String(data: data, encoding: .utf8)
    }

    public func write(_ passphrase: String) throws {
        let data = Data(passphrase.utf8)
        let update = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if update == errSecSuccess { return }
        guard update == errSecItemNotFound else { throw KeychainError(status: update) }
        var item = query
        item[kSecValueData as String] = data
        item[kSecAttrLabel as String] = "Vision Native backup passphrase"
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else { throw KeychainError(status: status) }
    }

    public func delete() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError(status: status) }
    }

    public func contains() -> Bool {
        var request = query
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        return SecItemCopyMatching(request as CFDictionary, &result) == errSecSuccess
    }
}

/// `{ hasEnvPassphrase, hasStoredPassphrase, secureStorageAvailable }`.
public struct PassphraseStatus: Equatable, Sendable {
    public var hasEnvPassphrase: Bool
    public var hasStoredPassphrase: Bool
    public var secureStorageAvailable: Bool

    public init(hasEnvPassphrase: Bool, hasStoredPassphrase: Bool, secureStorageAvailable: Bool) {
        self.hasEnvPassphrase = hasEnvPassphrase
        self.hasStoredPassphrase = hasStoredPassphrase
        self.secureStorageAvailable = secureStorageAvailable
    }

    /// The `backup:get-encryption-status` reply: `{ success: true, ...status }`.
    public var jsonValue: JSONValue {
        .object([
            "success": .bool(true),
            "hasEnvPassphrase": .bool(hasEnvPassphrase),
            "hasStoredPassphrase": .bool(hasStoredPassphrase),
            "secureStorageAvailable": .bool(secureStorageAvailable),
        ])
    }
}

/// `PassphraseUpdateResult`.
public struct PassphraseUpdateResult: Equatable, Sendable {
    public var success: Bool
    public var available: Bool
    public var error: String?

    public init(success: Bool, available: Bool, error: String? = nil) {
        self.success = success
        self.available = available
        self.error = error
    }

    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["success": .bool(success), "available": .bool(available)]
        if let error { fields["error"] = .string(error) }
        return .object(fields)
    }
}

/// The passphrase lifecycle of `packaging/electron/backup/crypto.ts`.
public enum BackupPassphrase {
    /// The environment passphrase, which wins over the stored one.
    public static let environmentKey = "VISION_BACKUP_PASSPHRASE"
    public static let unavailableMessage = "OS secure storage is not available on this device."
    /// `ERR_PASSPHRASE_REQUIRED` and `ERR_INVALID_PASSPHRASE`: the renderer matches these
    /// to reopen its passphrase prompt.
    public static let required = "PASSPHRASE_REQUIRED"
    public static let invalid = "INVALID_PASSPHRASE"

    /// `getBackupPassphrase`: the environment value, else the stored one, else `nil`.
    public static func resolve(environment: [String: String], store: (any PassphraseStore)?) -> String? {
        if let value = environment[environmentKey], !value.isEmpty { return value }
        guard let store, store.contains() else { return nil }
        guard let stored = try? store.read(), !stored.isEmpty else { return nil }
        return stored
    }

    /// `getBackupPassphraseStatus`. The Keychain needs no availability probe: it is present
    /// on every Mac, and `setPassphrase` reports a failed write.
    public static func status(environment: [String: String], store: (any PassphraseStore)?) -> PassphraseStatus {
        PassphraseStatus(
            hasEnvPassphrase: !(environment[environmentKey] ?? "").isEmpty,
            hasStoredPassphrase: store?.contains() ?? false,
            secureStorageAvailable: store != nil)
    }

    /// `setBackupPassphrase` with the already-trimmed value: empty removes it.
    public static func set(_ passphrase: String, store: (any PassphraseStore)?) -> PassphraseUpdateResult {
        if passphrase.isEmpty {
            guard let store else { return PassphraseUpdateResult(success: true, available: true) }
            do {
                try store.delete()
                return PassphraseUpdateResult(success: true, available: true)
            } catch {
                return PassphraseUpdateResult(success: false, available: true, error: backupErrorString(error))
            }
        }
        guard let store else { return PassphraseUpdateResult(success: false, available: false, error: unavailableMessage) }
        do {
            try store.write(passphrase)
            return PassphraseUpdateResult(success: true, available: true)
        } catch {
            // Electron: the store exists but the write failed, `String(err)`.
            return PassphraseUpdateResult(success: false, available: true, error: backupErrorString(error))
        }
    }
}

/// Device id, retention, the iCloud Drive default and the legacy SQL format.
public enum BackupDevice {
    /// `getBackupDeviceId`'s value before it is persisted: the first 8 hex digits of
    /// SHA-1(`platform|arch|hostname|userData`).
    public static func deviceId(platform: String, architecture: String, hostname: String, userData: String) -> String {
        let token = [platform, architecture, hostname, userData].joined(separator: "|")
        let digest = Insecure.SHA1.hash(data: Data(token.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(8))
    }

    /// `process.arch`.
    public static var architecture: String {
        #if arch(arm64)
            return "arm64"
        #else
            return "x64"
        #endif
    }

    /// `os.hostname()`.
    public static var hostname: String {
        var buffer = [CChar](repeating: 0, count: 256)
        guard gethostname(&buffer, buffer.count) == 0 else { return "" }
        return String(cString: buffer)
    }

    /// The persisted `backupDeviceId`, else a new one written to `settings.json`.
    public static func resolveDeviceId(
        settings: [String: JSONValue], userData: String, persist: (String) async throws -> Void
    ) async throws -> String {
        if let stored = settings["backupDeviceId"]?.stringValue, !stored.isEmpty { return stored }
        let id = deviceId(platform: "darwin", architecture: architecture, hostname: hostname, userData: userData)
        try await persist(id)
        return id
    }

    /// `getDefaultICloudBackupDir`: `~/Library/Mobile Documents/com~apple~CloudDocs/<app>/Backups`
    /// when iCloud Drive exists, else empty.
    public static func defaultICloudBackupDirectory(homeDirectory: String, appName: String, fileExists: (String) -> Bool)
        -> String
    {
        let root = PathUtilities.join(homeDirectory, "Library", "Mobile Documents", "com~apple~CloudDocs")
        guard fileExists(root) else { return "" }
        return PathUtilities.join(root, appName, "Backups")
    }
}

/// `cleanupOldBackups`.
public enum BackupRetention {
    public static let keep = 7
    public static let graceMilliseconds = 10 * 60 * 1000

    /// Keeps the newest `keep` backups of this device and removes older ones whose mtime is
    /// beyond the grace window; removes `*.partial` leftovers beyond the window too.
    @discardableResult
    public static func cleanup(
        directory: String, deviceId: String, now: Date, keep: Int = BackupRetention.keep,
        graceMilliseconds: Int = BackupRetention.graceMilliseconds
    ) -> Int {
        let prefix = "vision_backup_\(deviceId)_"
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return 0 }
        let grace = Double(graceMilliseconds) / 1000
        let suffixes = [".sql", ".sql.enc", ".visionbak", ".visionbak.enc"]
        let backups = names.filter { name in name.hasPrefix(prefix) && suffixes.contains { name.hasSuffix($0) } }
            .compactMap { name -> (path: String, modified: Date)? in
                let path = PathUtilities.join(directory, name)
                guard let modified = BackupFiles.modificationDate(path) else { return nil }
                return (path, modified)
            }
            .sorted { $0.modified > $1.modified }
        var removed = 0
        for backup in backups.dropFirst(keep) where now.timeIntervalSince(backup.modified) > grace {
            if unlink(backup.path) == 0 { removed += 1 }
        }
        for name in names where name.hasPrefix(prefix) && name.hasSuffix(".partial") {
            let path = PathUtilities.join(directory, name)
            guard let modified = BackupFiles.modificationDate(path), now.timeIntervalSince(modified) > grace else {
                continue
            }
            if unlink(path) == 0 { removed += 1 }
        }
        return removed
    }
}

/// The legacy `.sql` / `.sql.enc` backups (`VISIONENC1` / `VISIONENC2`).
public enum LegacySQLBackup {
    public static let magicV1 = Array("VISIONENC1".utf8)
    public static let magicV2 = Array("VISIONENC2".utf8)

    /// `decryptBackupFileToTemp`'s options. The v1 salt is `<APP_NAME lowercased>-backup-v1`
    /// of Electron Vision ("Vision").
    public static let format = EncryptedFile.Format(
        v1Magic: magicV1,
        v2Magic: magicV2,
        v1Salt: "vision-backup-v1",
        requiredError: BackupPassphrase.required,
        invalidError: BackupPassphrase.invalid,
        invalidHeaderMessage: "Invalid encrypted backup header.",
        unsupportedFormatMessage: "Backup is not in a supported encrypted format.")

    /// `isEncryptedBackupFile`.
    public static func isEncrypted(_ path: String) -> Bool {
        EncryptedFile.isEncrypted(path, magics: [magicV1, magicV2])
    }
}
