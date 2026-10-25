import Foundation

/// Existing desktop host contracts. Picker cancellation is nil; missing receipts are not success.
@MainActor public protocol NativeSettingsDesktopService {
    var isAvailable: Bool { get }
    func loadBackupSettings() async throws -> BackupSettingsValue
    func saveBackupSettings(_ settings: BackupSettingsValue) async throws
    func selectBackupDirectory() async throws -> String?
    func selectBackupFile() async throws -> String?
    func backupEncryptionStatus() async throws -> PassphraseStatus?
    func setBackupPassphrase(_ passphrase: String) async throws -> PassphraseUpdateResult?
    func captureFrontendState() async throws -> String?
    func runBackup(directory: String, frontendStateJSON: String?) async throws -> JSONValue?
    func isBackupEncrypted(path: String) async throws -> Bool
    func restoreBackup(path: String, passphrase: String?) async throws -> JSONValue?
    func applyRestoredFrontendState(_ state: JSONValue) async throws
    func reloadFrontend() async throws
    func readBackupReminder() async throws -> Bool
    func writeBackupReminder(dismissed: Bool) async throws
}
@MainActor public struct NativeSettingsDesktopCallbacks: NativeSettingsDesktopService {
    public let isAvailable: Bool
    private let readSettings: () async throws -> BackupSettingsValue
    private let writeSettings: (BackupSettingsValue) async throws -> Void
    private let chooseDirectory: () async throws -> String?
    private let chooseFile: () async throws -> String?
    private let readEncryption: () async throws -> PassphraseStatus?
    private let writePassphrase: (String) async throws -> PassphraseUpdateResult?
    private let capture: () async throws -> String?
    private let backup: (String, String?) async throws -> JSONValue?
    private let encrypted: (String) async throws -> Bool
    private let restore: (String, String?) async throws -> JSONValue?
    private let applyState: (JSONValue) async throws -> Void
    private let reload: () async throws -> Void
    private let readReminder: () async throws -> Bool
    private let writeReminder: (Bool) async throws -> Void
    public init(
        isAvailable: Bool = true,
        loadBackupSettings: @escaping () async throws -> BackupSettingsValue,
        saveBackupSettings: @escaping (BackupSettingsValue) async throws -> Void,
        selectBackupDirectory: @escaping () async throws -> String?,
        selectBackupFile: @escaping () async throws -> String?,
        backupEncryptionStatus: @escaping () async throws -> PassphraseStatus?,
        setBackupPassphrase: @escaping (String) async throws -> PassphraseUpdateResult?,
        captureFrontendState: @escaping () async throws -> String?,
        runBackup: @escaping (String, String?) async throws -> JSONValue?,
        isBackupEncrypted: @escaping (String) async throws -> Bool,
        restoreBackup: @escaping (String, String?) async throws -> JSONValue?,
        applyRestoredFrontendState: @escaping (JSONValue) async throws -> Void,
        reloadFrontend: @escaping () async throws -> Void,
        readBackupReminder: @escaping () async throws -> Bool,
        writeBackupReminder: @escaping (Bool) async throws -> Void
    ) {
        self.isAvailable = isAvailable
        readSettings = loadBackupSettings
        writeSettings = saveBackupSettings
        chooseDirectory = selectBackupDirectory
        chooseFile = selectBackupFile
        readEncryption = backupEncryptionStatus
        writePassphrase = setBackupPassphrase
        capture = captureFrontendState
        backup = runBackup
        encrypted = isBackupEncrypted
        restore = restoreBackup
        applyState = applyRestoredFrontendState
        reload = reloadFrontend
        readReminder = readBackupReminder
        writeReminder = writeBackupReminder
    }
    public func loadBackupSettings() async throws -> BackupSettingsValue { try await readSettings() }
    public func saveBackupSettings(_ settings: BackupSettingsValue) async throws { try await writeSettings(settings) }
    public func selectBackupDirectory() async throws -> String? { try await chooseDirectory() }
    public func selectBackupFile() async throws -> String? { try await chooseFile() }
    public func backupEncryptionStatus() async throws -> PassphraseStatus? { try await readEncryption() }
    public func setBackupPassphrase(_ passphrase: String) async throws -> PassphraseUpdateResult? {
        try await writePassphrase(passphrase)
    }
    public func captureFrontendState() async throws -> String? { try await capture() }
    public func runBackup(directory: String, frontendStateJSON: String?) async throws -> JSONValue? {
        try await backup(directory, frontendStateJSON)
    }
    public func isBackupEncrypted(path: String) async throws -> Bool { try await encrypted(path) }
    public func restoreBackup(path: String, passphrase: String?) async throws -> JSONValue? {
        try await restore(path, passphrase)
    }
    public func applyRestoredFrontendState(_ state: JSONValue) async throws { try await applyState(state) }
    public func reloadFrontend() async throws { try await reload() }
    public func readBackupReminder() async throws -> Bool { try await readReminder() }
    public func writeBackupReminder(dismissed: Bool) async throws { try await writeReminder(dismissed) }
}

/// The source electronErrorToMessage unwrap rules, also used for legacy backup receipts.
public enum NativeSettingsDesktopError {
    public static func message(_ raw: String?, strings: any Localizing) -> String {
        var value = (raw ?? "").replacingOccurrences(of: "^(?:Error:\\s*)+", with: "", options: .regularExpression)
        value = value.replacingOccurrences(
            of: "^Error invoking remote method '[^']*':\\s*", with: "", options: .regularExpression)
        value = value.replacingOccurrences(of: "^(?:Error:\\s*)+", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let patterns = [
            ("\\bENOENT\\b", "electronError.notFound"), ("\\b(EACCES|EPERM)\\b", "electronError.permission"),
            ("\\b(ENOSPC|EDQUOT)\\b", "electronError.diskFull"), ("(?i)^workDir not set$", "electronError.notReady"),
            ("(?i)^Unauthorized sender", "electronError.unknown"),
        ]
        if value.isEmpty { return strings.t("electronError.unknown") }
        for (pattern, key) in patterns where value.range(of: pattern, options: .regularExpression) != nil {
            return strings.t(key)
        }
        return value
    }
    public static func newerSchemaDescription(_ message: String) -> String? {
        guard let range = message.range(of: "BUNDLE_SCHEMA_NEWER:") else { return nil }
        return String(message[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

public enum NativeSettingsBackupNotice {
    public static func lifetime(_ notice: ScreenNotice) -> TimeInterval {
        switch notice.key {
        case "settings.restore.success": return 8
        case "settings.backup.passphrase.reminderTitle": return 10
        case "settings.restore.schemaMismatch": return 12
        default: return 4
        }
    }
    public static func duration(_ notice: ScreenNotice) -> Duration { .seconds(lifetime(notice)) }
    public static func detail(_ notice: ScreenNotice, strings: any Localizing) -> String? {
        switch notice.key {
        case "settings.backup.success": return strings.t("settings.backup.successDesc", notice.variables)
        case "settings.restore.success": return strings.t("settings.restore.successDesc", notice.variables)
        case "settings.backup.passphrase.reminderTitle": return strings.t("settings.backup.passphrase.reminderDesc")
        case "settings.restore.schemaMismatch": return notice.detail
        default: return notice.detail.map { NativeSettingsDesktopError.message($0, strings: strings) }
        }
    }
}
