import Foundation

/// `settings.json` access for the backup device id (`RuntimeSupervisor` conforms).
public protocol BackupSettingsStore: Sendable {
    func currentSettings() async -> [String: JSONValue]
    func updateSettings(_ update: @Sendable (inout [String: JSONValue]) -> Void) async throws
}

/// Fixed facts the backup channels need.
public struct BackupContext: Sendable {
    /// The app's environment, for `VISION_BACKUP_PASSPHRASE`.
    public var environment: [String: String]
    /// `app.getVersion()`, written to `metadata.json`.
    public var appVersion: String
    /// `app.getPath("userData")`, part of the device id.
    public var userDataDirectory: String
    public var homeDirectory: String
    /// The folder name below iCloud Drive (`APP_NAME`).
    public var appName: String
    /// Parent of the temporary work directories; `nil` uses `NSTemporaryDirectory()`.
    public var temporaryDirectory: String?

    public init(
        environment: [String: String], appVersion: String, userDataDirectory: String, homeDirectory: String,
        appName: String, temporaryDirectory: String? = nil
    ) {
        self.environment = environment
        self.appVersion = appVersion
        self.userDataDirectory = userDataDirectory
        self.homeDirectory = homeDirectory
        self.appName = appName
        self.temporaryDirectory = temporaryDirectory
    }
}

/// Paths the restore file picker returned (`ALLOWED_RESTORE_PATHS`): `backup:is-encrypted`
/// and `backup:restore` accept no other path.
public struct RestorePathAllowList: Sendable {
    private var paths: Set<String> = []

    public init() {}

    /// Adds a picked path and returns it resolved (`path.resolve`).
    @discardableResult
    public mutating func add(_ path: String) -> String {
        let resolved = PathUtilities.normalize(path)
        paths.insert(resolved)
        return resolved
    }

    public func contains(_ resolvedPath: String) -> Bool {
        paths.contains(resolvedPath)
    }
}

/// Runs blocking file and crypto work off the cooperative thread pool.
func runBlocking<T: Sendable>(_ work: @escaping @Sendable () throws -> T) async throws -> T {
    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<T, Error>) in
        DispatchQueue.global(qos: .utility).async {
            continuation.resume(with: Result { try work() })
        }
    }
}

/// The main-process side of the backup channels (`backup:run`, `backup:restore`,
/// `backup:is-encrypted`, `backup:get-encryption-status`, `backup:set-passphrase`) and the
/// quit-time backup, following `packaging/electron/main.ts`, `backup/restore.ts` and
/// `backup/crypto.ts`. Dialogs stay with the app; this type has no AppKit dependency.
/// The quit-time backup's result, for the system notification.
public enum QuitBackupOutcome: Equatable, Sendable { case saved, failed }

public actor BackupService {
    private let context: BackupContext
    private let settings: any BackupSettingsStore
    private let runtimeProvider: @Sendable () async -> (any BackupRuntime)?
    /// The audit hooks of the active runtime (phase 1e); `nil` restores without them.
    private let auditProvider: @Sendable () async -> (any AuditRestoreGuard)?
    private let passphraseStoreFactory: @Sendable (String) -> (any PassphraseStore)?
    private let logger: any RuntimeLogging
    private let now: @Sendable () -> Date
    /// `backupInFlight`: the running backup, which a quit-time backup waits for.
    private var backupTask: Task<JSONValue, Never>?
    /// A restore is switching the database and attachments; backups wait until it ends.
    private var restoreInFlight = false

    public init(
        context: BackupContext,
        settings: any BackupSettingsStore,
        runtimeProvider: @escaping @Sendable () async -> (any BackupRuntime)?,
        passphraseStoreFactory: @escaping @Sendable (String) -> (any PassphraseStore)? = {
            KeychainPassphraseStore(account: $0)
        },
        logger: any RuntimeLogging,
        now: @escaping @Sendable () -> Date = { Date() },
        auditProvider: @escaping @Sendable () async -> (any AuditRestoreGuard)? = { nil }
    ) {
        self.context = context
        self.settings = settings
        self.runtimeProvider = runtimeProvider
        self.auditProvider = auditProvider
        self.passphraseStoreFactory = passphraseStoreFactory
        self.logger = logger
        self.now = now
    }

    // MARK: - Settings and passphrase

    /// `getDefaultICloudBackupDir`.
    public nonisolated var defaultICloudBackupDirectory: String {
        BackupDevice.defaultICloudBackupDirectory(
            homeDirectory: context.homeDirectory, appName: context.appName, fileExists: BackupFiles.isDirectory)
    }

    /// The folder picker's starting directory: iCloud Drive, else Documents.
    public nonisolated var pickerDefaultDirectory: String {
        let iCloud = defaultICloudBackupDirectory
        return iCloud.isEmpty ? PathUtilities.join(context.homeDirectory, "Documents") : iCloud
    }

    /// `getBackupDeviceId`.
    public func deviceId() async throws -> String {
        let store = settings
        return try await BackupDevice.resolveDeviceId(
            settings: await store.currentSettings(), userData: context.userDataDirectory,
            persist: { id in try await store.updateSettings { $0["backupDeviceId"] = .string(id) } })
    }

    private func passphraseStore() async -> (any PassphraseStore)? {
        guard let id = try? await deviceId() else { return nil }
        return passphraseStoreFactory(id)
    }

    /// `getBackupPassphrase`.
    public func passphrase() async -> String? {
        if let value = context.environment[BackupPassphrase.environmentKey], !value.isEmpty { return value }
        return BackupPassphrase.resolve(environment: [:], store: await passphraseStore())
    }

    /// `backup:get-encryption-status`.
    public func encryptionStatus() async -> PassphraseStatus {
        BackupPassphrase.status(environment: context.environment, store: await passphraseStore())
    }

    /// `backup:set-passphrase` (the handler trims the value).
    public func setPassphrase(_ passphrase: String) async -> PassphraseUpdateResult {
        BackupPassphrase.set(Self.trimPassphrase(passphrase), store: await passphraseStore())
    }

    private static func trimPassphrase(_ value: String) -> String {
        // Match the Electron handler's String.trim(): BOM is whitespace; NEL is not.
        let whitespace = CharacterSet(
            charactersIn:
                "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
        )
        return value.trimmingCharacters(in: whitespace)
    }

    // MARK: - Backup

    private func requireRuntime() async throws -> any BackupRuntime {
        guard let runtime = await runtimeProvider() else {
            throw BackupFailure("Vision backup and restore require the native runtime")
        }
        return runtime
    }

    /// `backup:run`: one backup at a time, and none while a restore runs.
    public func runBackup(destination: String, frontendStateJson: String?) async -> JSONValue {
        if backupTask != nil {
            return .object(["success": .bool(false), "error": .string("A backup is already in progress")])
        }
        if restoreInFlight {
            return .object(["success": .bool(false), "error": .string("A restore is in progress")])
        }
        let task = Task { await self.backupResult(destination: destination, frontendStateJson: frontendStateJson) }
        backupTask = task
        let result = await task.value
        backupTask = nil
        return result
    }

    private func backupResult(destination: String, frontendStateJson: String?) async -> JSONValue {
        do {
            return try await runBundleBackup(destination: destination, frontendStateJson: frontendStateJson)
        } catch {
            return .object(["success": .bool(false), "error": .string(backupErrorString(error))])
        }
    }

    /// `runBundleBackup`: dump and attachments into a private work directory, the bundle in
    /// `destination`, v2 encryption when a passphrase is configured, then retention.
    public func runBundleBackup(destination: String, frontendStateJson: String?) async throws -> JSONValue {
        guard !destination.isEmpty else { throw BackupFailure("No backup directory configured") }
        let runtime = try await requireRuntime()
        let deviceId = try await deviceId()
        let work = try BackupFiles.makeTemporaryDirectory(prefix: "vision_bak_", in: context.temporaryDirectory)
        defer { BackupFiles.remove(work) }
        let dbSqlPath = PathUtilities.join(work, "db.sql")
        let attachments = PathUtilities.join(work, "attachments")
        try await runtime.dumpDatabase(to: dbSqlPath)
        try await runtime.exportAttachments(to: attachments)
        var frontendState: JSONValue?
        if let frontendStateJson, !frontendStateJson.isEmpty {
            // Invalid optional UI state does not invalidate the database backup.
            frontendState = try? JSONValue.parse(Data(frontendStateJson.utf8))
        }
        let schemaHead = try await runtime.schemaHead()
        let appVersion = context.appVersion
        let date = now()
        let state = frontendState
        let bundlePath = try await runBlocking {
            try BackupBundle.create(
                destinationDirectory: destination, deviceId: deviceId, schemaHead: schemaHead, appVersion: appVersion,
                dbSqlPath: dbSqlPath, attachmentsDirectory: attachments, frontendState: state, now: date)
        }
        var finalPath = bundlePath
        var encrypted = false
        var warning: String?
        if let secret = await passphrase() {
            finalPath = try await runBlocking { try BackupBundle.encrypt(bundlePath, passphrase: secret) }
            encrypted = true
        } else {
            warning = "Backup encryption skipped: no passphrase configured."
        }
        let cleanupDate = now()
        let removed = try await runBlocking {
            BackupRetention.cleanup(directory: destination, deviceId: deviceId, now: cleanupDate)
        }
        var result: [String: JSONValue] = [
            "success": .bool(true), "file": .string(finalPath), "encrypted": .bool(encrypted),
            "cleanupRemoved": .int(removed),
        ]
        if let warning { result["warning"] = .string(warning) }
        return .object(result)
    }

    /// The `will-quit` backup: when the effective settings (with the iCloud Drive default)
    /// enable it, a bundle without frontend state. A backup already running is awaited
    /// instead of starting a second one. Failures are logged; the caller's quit timeout
    /// bounds the whole step. The outcome drives Electron's `backup.done` / `backup.failed`
    /// notification; `nil` means no quit backup ran.
    @discardableResult
    public func runQuitBackup(rawSettings: JSONValue?) async -> QuitBackupOutcome? {
        if restoreInFlight {
            logger.log("warn", "[backup] quit: a restore is in progress; skipping the quit backup")
            return nil
        }
        if let running = backupTask {
            logger.log("log", "[backup] quit: waiting for the backup already in progress")
            _ = await running.value
            return nil
        }
        let effective = BackupSettings.resolved(rawSettings, defaultDirectory: defaultICloudBackupDirectory)
        guard effective.backupOnQuit, !effective.backupDir.isEmpty else { return nil }
        let result = await runBackup(destination: effective.backupDir, frontendStateJson: nil)
        if result["success"] == .bool(true) {
            if let warning = result["warning"]?.stringValue { logger.log("warn", "[backup] \(warning)") }
            logger.log("log", "[backup] quit backup saved: \(result["file"]?.stringValue ?? "")")
            return .saved
        } else {
            logger.log("error", "[backup] Backup on quit failed: \(result["error"]?.stringValue ?? "unknown error")")
            return .failed
        }
    }

    // MARK: - Restore

    /// `backup:is-encrypted` for a picked path.
    public nonisolated func isEncrypted(_ path: String) async -> Bool {
        let encrypted = try? await runBlocking { () -> Bool in
            guard BackupFiles.exists(path) else { return false }
            if path.hasSuffix(".visionbak") || path.hasSuffix(".visionbak.enc") {
                return BackupBundle.isEncrypted(path)
            }
            return LegacySQLBackup.isEncrypted(path)
        }
        return encrypted ?? false
    }

    /// `backup:restore` for a picked path: the confirmation, then the bundle or legacy
    /// restore through `restoreWithAuditRecovery`. Errors resolve as
    /// `{ success: false, error: String(err) }`. A restore whose audit history does not
    /// verify is offered once more, with `confirmAuditRecovery` (the second warning, given
    /// the error's `auditStatus`); accepted, it restores without the audit check, ends
    /// the audit session and answers `auditStatus: "unavailable"`.
    public func restore(
        path: String, passphrase: String?, confirm: @Sendable () async -> Bool,
        confirmAuditRecovery: @Sendable (_ auditStatus: String?) async -> Bool = { _ in false }
    ) async -> JSONValue {
        guard BackupFiles.exists(path) else {
            return .object(["success": .bool(false), "error": .string("Backup file not found")])
        }
        guard await confirm() else {
            return .object(["success": .bool(false), "error": .string("Restore cancelled by user")])
        }
        guard !restoreInFlight else {
            return .object(["success": .bool(false), "error": .string("A restore is already in progress")])
        }
        restoreInFlight = true
        defer { restoreInFlight = false }
        let lower = path.lowercased()
        let isBundle = lower.hasSuffix(".visionbak") || lower.hasSuffix(".visionbak.enc")
        func restoreSelected(_ allowUnverifiedAudit: Bool) async throws -> JSONValue {
            if isBundle {
                return try await runBundleRestore(
                    path, passphrase: passphrase, allowUnverifiedAudit: allowUnverifiedAudit)
            }
            return try await runRestore(path, passphrase: passphrase, allowUnverifiedAudit: allowUnverifiedAudit)
        }
        do {
            do {
                return try await restoreSelected(false)
            } catch let error as AuditRestoreError
                where AuditRestoreError.recoveryCodes.contains(error.code) && !error.recoveryUnsafe
            {
                logger.log("warn", "[backup] restore audit check failed: \(error.code)")
                guard await confirmAuditRecovery(error.auditStatus) else {
                    return .object(["success": .bool(false), "error": .string("Restore cancelled by user")])
                }
                var result = try await restoreSelected(true).objectValue ?? [:]
                await auditProvider()?.endAuditSession()
                result["auditStatus"] = .string("unavailable")
                return .object(result)
            }
        } catch {
            logger.log("error", "[backup] restore failed: \(backupErrorMessage(error))")
            return .object(["success": .bool(false), "error": .string(backupErrorString(error))])
        }
    }

    private static let invalidPassphrasePattern =
        #"bad decrypt|wrong final block|unable to authenticate|missing metadata\.json|missing db\.sql|end of central directory|not a zip file"#

    /// The live database's revision, else the payload's migration chain head
    /// (`getLocalMigrationChainHead`), else empty.
    private func currentSchemaHead(_ runtime: any BackupRuntime) async -> String {
        if let live = try? await runtime.schemaHead(), !live.isEmpty { return live }
        return await runtime.migrationChainHead()
    }

    /// `assertBackupSchemaCompatible`, except that a numbered backup revision is refused
    /// when this install's revision cannot be determined, instead of restoring unchecked.
    private func checkSchema(_ candidate: String, runtime: any BackupRuntime, noun: String) async throws {
        guard BackupRestore.revisionNumericPrefix(candidate) != nil else { return }
        let current = await currentSchemaHead(runtime)
        guard BackupRestore.revisionNumericPrefix(current) != nil else {
            throw BackupFailure(
                "SCHEMA_UNKNOWN: This \(noun) was created on schema revision \"\(candidate)\" but this Vision "
                    + "install's schema revision could not be determined, so it was not restored.")
        }
        try BackupRestore.assertSchemaCompatible(candidate, current: current, noun: noun)
    }

    /// `runBundleRestore`.
    public func runBundleRestore(
        _ bundlePath: String, passphrase requested: String?, allowUnverifiedAudit: Bool = false
    ) async throws -> JSONValue {
        guard !bundlePath.isEmpty else { throw BackupFailure("No backup file specified") }
        guard BackupFiles.exists(bundlePath) else { throw BackupFailure("File not found: \(bundlePath)") }
        let encrypted = BackupBundle.isEncrypted(bundlePath)
        var effective: String?
        if encrypted {
            if let requested, !requested.isEmpty { effective = requested } else { effective = await passphrase() }
            guard effective != nil else { throw BackupFailure(BackupPassphrase.required) }
        }
        let opened: OpenedBundle
        do {
            let secret = effective
            let parent = context.temporaryDirectory
            opened = try await runBlocking {
                try BackupBundle.open(bundlePath, passphrase: secret, temporaryParent: parent)
            }
        } catch {
            if encrypted,
                PathUtilities.contains(backupErrorMessage(error), Self.invalidPassphrasePattern, caseInsensitive: true)
            {
                throw BackupFailure(BackupPassphrase.invalid)
            }
            throw error
        }
        defer { opened.cleanup() }
        let runtime = try await requireRuntime()
        var schemaHead: String?
        if let raw = opened.metadata["schemaHead"], raw.isTruthy {
            let head = BackupRestore.javaScriptString(raw)
            schemaHead = head
            try await checkSchema(head, runtime: runtime, noun: "bundle")
        }
        let logger = self.logger
        let warning = try await BackupRestore.restoreBundle(
            runtime, dbSqlPath: opened.dbSqlPath, attachmentsDirectory: opened.attachmentsDirectory,
            expectedSchemaHead: schemaHead, audit: await auditProvider(), allowUnverifiedAudit: allowUnverifiedAudit,
            log: { logger.log("error", "[backup] \($0)") })
        var result: [String: JSONValue] = [
            "success": .bool(true), "file": .string(bundlePath), "frontendState": opened.frontendState ?? .null,
        ]
        if let warning { result["warning"] = .string(warning) }
        return .object(result)
    }

    /// `runRestore`: a legacy `.sql` or `.sql.enc` dump.
    public func runRestore(
        _ sqlPath: String, passphrase requested: String?, allowUnverifiedAudit: Bool = false
    ) async throws -> JSONValue {
        guard !sqlPath.isEmpty else { throw BackupFailure("No backup file specified") }
        guard BackupFiles.exists(sqlPath) else { throw BackupFailure("File not found: \(sqlPath)") }
        var source = sqlPath
        var temporary: String?
        defer { if let temporary { BackupFiles.remove(temporary) } }
        if LegacySQLBackup.isEncrypted(sqlPath) {
            var candidate: String?
            if let requested, !requested.isEmpty { candidate = requested } else { candidate = await passphrase() }
            guard let effective = candidate else { throw BackupFailure(BackupPassphrase.required) }
            let directory = try BackupFiles.makeTemporaryDirectory(prefix: "vision_restore_", in: context.temporaryDirectory)
            temporary = directory
            let destination = PathUtilities.join(
                directory, "vision_restore_\(epochMilliseconds(now()))_\(ProcessInfo.processInfo.processIdentifier).sql")
            try await runBlocking {
                try EncryptedFile.decrypt(
                    encryptedPath: sqlPath, destinationPath: destination, passphrase: effective,
                    format: LegacySQLBackup.format)
            }
            source = destination
        }
        let runtime = try await requireRuntime()
        let restoreSource = source
        let dumpHead = try await runBlocking { BackupRestore.readDumpSchemaHead(restoreSource) }
        if !dumpHead.isEmpty {
            try await checkSchema(dumpHead, runtime: runtime, noun: "backup")
        }
        let logger = self.logger
        try await BackupRestore.restoreDatabase(
            runtime, source: source, format: .plain, expectedSchemaHead: dumpHead.isEmpty ? nil : dumpHead,
            audit: await auditProvider(), allowUnverifiedAudit: allowUnverifiedAudit,
            log: { logger.log("error", "[backup] \($0)") })
        return .object(["success": .bool(true), "file": .string(sqlPath)])
    }
}
