import Foundation
import Observation

@MainActor @Observable public final class NativeSettingsBackupModel {
    public static let reminderKey = "vision.backup.passphrase.reminder.dismissed"
    public private(set) var backupDir = ""
    public private(set) var backupOnQuit = false
    public private(set) var loaded = false
    public private(set) var settingsLoading = false
    public private(set) var encryptionLoading = false
    public private(set) var backupRunning = false
    public private(set) var savingBackupPassphrase = false
    public private(set) var encryptionStatus: PassphraseStatus?
    public var backupPassphrase = ""
    public private(set) var reminderDismissed = false
    public private(set) var restoreFile = ""
    public private(set) var restoreRunning = false
    public private(set) var restoreSubmitting = false
    public private(set) var pendingConfirmationFile: String?
    public private(set) var pendingRestoreFile: String?
    public var restorePassphrase = ""
    public var showRestorePassphrase = false
    public private(set) var notices: [ScreenNotice] = []
    public var didNotice: (@MainActor (ScreenNotice) -> Void)?
    @ObservationIgnored public var didRestore: (@MainActor () async -> Void)?
    public var usesExternalNotices: Bool { didNotice != nil }
    public private(set) var settingsError: String?
    public var isAvailable: Bool { service.isAvailable }
    public var backupLoading: Bool { settingsLoading || encryptionLoading }
    public var passphraseControlsDisabled: Bool {
        backupLoading || savingBackupPassphrase || encryptionStatus?.secureStorageAvailable != true
    }
    public var passphraseStatusKey: String {
        guard let status = encryptionStatus else { return "settings.backup.passphrase.statusUnknown" }
        if status.hasEnvPassphrase { return "settings.backup.passphrase.statusEnv" }
        return status.hasStoredPassphrase
            ? "settings.backup.passphrase.statusStored" : "settings.backup.passphrase.statusMissing"
    }
    public var showsReminder: Bool {
        encryptionStatus.map { $0.hasEnvPassphrase || $0.hasStoredPassphrase } == true && !reminderDismissed
    }
    public var restorePassphrasePresented: Bool { pendingRestoreFile != nil }
    @ObservationIgnored private let service: any NativeSettingsDesktopService
    @ObservationIgnored private let reloadDelay: Duration
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private var visit = UUID()
    @ObservationIgnored private var settingsRevision = UUID()
    @ObservationIgnored private var loadTask: Task<Void, Never>?
    @ObservationIgnored private var saveTask: Task<Void, Never>?
    @ObservationIgnored private var reloadTask: Task<Void, Never>?
    @ObservationIgnored private var workflow = UUID()
    @ObservationIgnored private var reminderRevision = UUID()
    @ObservationIgnored private var noticeID = 0
    public init(service: any NativeSettingsDesktopService, reloadDelay: Duration = .seconds(3)) {
        self.service = service
        self.reloadDelay = reloadDelay
    }
    /// Onboarding's independent restore card has no Backup settings/status/reminder queries.
    public func activateRestoreOnly() {
        guard isAvailable, !isActive else { return }
        isActive = true
        visit = UUID()
    }
    public func load() async {
        guard isAvailable, !Task.isCancelled else { return }
        if isActive {
            if let loadTask { await loadTask.value }
            return
        }
        isActive = true
        visit = UUID()
        let capturedVisit = visit
        let revision = settingsRevision
        let reminderScope = reminderRevision
        settingsLoading = true
        encryptionLoading = true
        let task = Task { [self] in
            guard isActive, visit == capturedVisit, !Task.isCancelled else { return }
            async let settings: Void = readSettings(visit: capturedVisit, revision: revision)
            async let encryption: Void = readEncryption(visit: capturedVisit)
            async let reminder: Void = readReminder(visit: capturedVisit, revision: reminderScope)
            _ = await (settings, encryption, reminder)
        }
        loadTask = task
        await task.value
        if visit == capturedVisit { loadTask = nil }
    }
    private func readSettings(visit captured: UUID, revision: UUID) async {
        guard isActive, captured == visit, !Task.isCancelled else { return }
        defer { if captured == visit { settingsLoading = false } }
        do {
            let value = try await service.loadBackupSettings()
            guard isActive, captured == visit, revision == settingsRevision else { return }
            backupDir = value.backupDir
            backupOnQuit = value.backupOnQuit
            loaded = true
            settingsError = nil
        } catch { if isActive, captured == visit { settingsError = error.localizedDescription } }
    }
    private func readEncryption(visit captured: UUID) async {
        guard isActive, captured == visit, !Task.isCancelled else { return }
        defer { if captured == visit { encryptionLoading = false } }
        if let value = try? await service.backupEncryptionStatus(), isActive, captured == visit {
            encryptionStatus = value
        }
    }
    private func readReminder(visit captured: UUID, revision: UUID) async {
        guard isActive, captured == visit, !Task.isCancelled else { return }
        let dismissed = (try? await service.readBackupReminder()) ?? false
        if isActive, captured == visit, revision == reminderRevision { reminderDismissed = dismissed }
    }
    public func browseDirectory() async {
        guard !backupLoading else { return }
        let captured = visit
        do {
            guard let chosen = try await service.selectBackupDirectory(), !chosen.isEmpty, isActive, captured == visit
            else { return }
            settingsRevision = UUID()
            backupDir = chosen
            loaded = true
            persist(.init(backupDir: chosen, backupOnQuit: backupOnQuit))
        } catch { enqueue("settings.backup.failed", kind: .error, detail: error.localizedDescription) }
    }
    public func setBackupOnQuit(_ value: Bool) {
        guard loaded || !backupDir.isEmpty else { return }
        settingsRevision = UUID()
        backupOnQuit = value
        persist(.init(backupDir: backupDir, backupOnQuit: value))
    }
    private func persist(_ settings: BackupSettingsValue) {
        let previous = saveTask
        let revision = settingsRevision
        saveTask = Task { [self] in
            await previous?.value
            do {
                try await service.saveBackupSettings(settings)
                if revision == settingsRevision { settingsError = nil }
            } catch {
                if revision == settingsRevision {
                    settingsError = error.localizedDescription
                    enqueue("settings.backup.failed", kind: .error, detail: error.localizedDescription)
                }
            }
        }
    }
    public func flushSettings() async { await saveTask?.value }
    public func runBackup() async {
        guard !backupRunning else { return }
        guard !backupDir.isEmpty else {
            enqueue("settings.backup.noDir", kind: .error)
            return
        }
        let directory = backupDir
        backupRunning = true
        defer { backupRunning = false }
        do {
            let snapshot = try? await service.captureFrontendState()
            guard let result = try await service.runBackup(directory: directory, frontendStateJSON: snapshot) else {
                return
            }
            if result["success"] == .bool(true) {
                enqueue("settings.backup.success", variables: ["file": result["file"]?.stringValue ?? ""])
                if let warning = result["warning"]?.stringValue { enqueue(warning, kind: .info) }
                if let count = result["cleanupRemoved"]?.intValue, count > 0 {
                    enqueue("settings.backup.cleanupRemoved", kind: .info, variables: ["count": String(count)])
                }
            } else {
                enqueue("settings.backup.failed", kind: .error, detail: result["error"]?.stringValue)
            }
        } catch { enqueue("settings.backup.failed", kind: .error, detail: error.localizedDescription) }
    }
    public func savePassphrase() async { await setPassphrase(backupPassphrase, showReminder: true) }
    public func clearPassphrase() async { await setPassphrase("", showReminder: false) }
    private func setPassphrase(_ value: String, showReminder: Bool) async {
        guard !passphraseControlsDisabled else { return }
        savingBackupPassphrase = true
        let captured = visit
        defer { savingBackupPassphrase = false }
        do {
            guard let result = try await service.setBackupPassphrase(value) else {
                enqueue("settings.backup.passphrase.unavailable", kind: .error)
                return
            }
            guard result.success else {
                enqueue("settings.backup.passphrase.saveFailed", kind: .error, detail: result.error)
                return
            }
            let refreshed = try await service.backupEncryptionStatus()
            guard isActive, captured == visit else { return }
            if let refreshed { encryptionStatus = refreshed }
            backupPassphrase = ""
            let saved = !NativeSettingsAIText.trim(value).isEmpty
            enqueue(saved ? "settings.backup.passphrase.saved" : "settings.backup.passphrase.cleared")
            if saved && showReminder {
                enqueue("settings.backup.passphrase.reminderTitle", kind: .info)
                let reminderScope = UUID()
                reminderRevision = reminderScope
                do {
                    try await service.writeBackupReminder(dismissed: false)
                    if isActive, captured == visit, reminderScope == reminderRevision { reminderDismissed = false }
                } catch {}
            }
        } catch { enqueue("settings.backup.passphrase.saveFailed", kind: .error, detail: error.localizedDescription) }
    }
    public func dismissReminder() async {
        reminderRevision = UUID()
        reminderDismissed = true
        try? await service.writeBackupReminder(dismissed: true)
    }
    public func selectRestoreFile() async {
        guard !restoreRunning else { return }
        let captured = visit
        do {
            if let path = try await service.selectBackupFile(), !path.isEmpty, isActive, captured == visit {
                restoreFile = path
            }
        } catch { enqueue("settings.restore.failed", kind: .error, detail: error.localizedDescription) }
    }
    public func requestRestoreConfirmation() {
        if !restoreRunning, !restoreFile.isEmpty { pendingConfirmationFile = restoreFile }
    }
    public func cancelRestoreConfirmation() { pendingConfirmationFile = nil }
    public func confirmRestore() async {
        guard let file = pendingConfirmationFile, !restoreRunning else { return }
        pendingConfirmationFile = nil
        await startRestore(file: file)
    }
    /// Called only after the caller's destructive confirmation; the host retains its own audit confirmations.
    public func startRestore(file: String) async {
        guard !file.isEmpty, !restoreRunning else { return }
        workflow = UUID()
        let captured = workflow
        restoreRunning = true
        let encrypted = (try? await service.isBackupEncrypted(path: file)) ?? false
        if encrypted {
            openPassphrase(file: file, workflow: captured)
            return
        }
        await performRestore(file: file, passphrase: nil, workflow: captured)
    }
    private func openPassphrase(file: String, workflow captured: UUID) {
        guard isActive, captured == workflow else { return }
        pendingRestoreFile = file
        restorePassphrase = ""
        showRestorePassphrase = false
    }
    public func submitRestorePassphrase() async {
        guard let file = pendingRestoreFile, !restorePassphrase.isEmpty, !restoreSubmitting else { return }
        restoreSubmitting = true
        let captured = workflow
        defer { if captured == workflow { restoreSubmitting = false } }
        await performRestore(file: file, passphrase: restorePassphrase, workflow: captured)
    }
    public func cancelRestorePassphrase() {
        guard !restoreSubmitting else { return }
        workflow = UUID()
        pendingRestoreFile = nil
        restorePassphrase = ""
        restoreRunning = false
    }
    private func performRestore(file: String, passphrase: String?, workflow captured: UUID) async {
        do {
            guard let result = try await service.restoreBackup(path: file, passphrase: passphrase) else {
                finishWorkflow(captured)
                return
            }
            if result["success"] == .bool(true) {
                if let state = result["frontendState"], state["keys"] != nil {
                    try? await service.applyRestoredFrontendState(state)
                }
                await didRestore?()
                enqueue("settings.restore.success", variables: ["file": result["file"]?.stringValue ?? file])
                finishWorkflow(captured)
                // An accepted database restore changes the whole app, even if this section has left.
                reloadTask?.cancel()
                reloadTask = Task { [service, reloadDelay] in
                    do {
                        try await Task.sleep(for: reloadDelay)
                        try await service.reloadFrontend()
                    } catch {}
                }
                return
            }
            let error = result["error"]?.stringValue ?? ""
            if error.contains("INVALID_PASSPHRASE") || error.contains("PASSPHRASE_REQUIRED") {
                guard isActive, captured == workflow else { return }
                if pendingRestoreFile == nil {
                    openPassphrase(file: file, workflow: captured)
                } else {
                    restorePassphrase = ""
                    enqueue(
                        error.contains("INVALID_PASSPHRASE")
                            ? "settings.restore.passphraseInvalid" : "settings.restore.passphraseRequired", kind: .error
                    )
                }
                return
            }
            if let description = NativeSettingsDesktopError.newerSchemaDescription(error) {
                enqueue("settings.restore.schemaMismatch", kind: .error, detail: description)
            } else {
                enqueue("settings.restore.failed", kind: .error, detail: error)
            }
        } catch { enqueue("settings.restore.failed", kind: .error, detail: error.localizedDescription) }
        finishWorkflow(captured)
    }
    private func finishWorkflow(_ captured: UUID) {
        guard isActive, captured == workflow else { return }
        pendingRestoreFile = nil
        restorePassphrase = ""
        restoreRunning = false
    }
    public func didDisappear() {
        isActive = false
        visit = UUID()
        settingsRevision = UUID()
        workflow = UUID()
        reminderRevision = UUID()
        loadTask?.cancel()
        loadTask = nil
        settingsLoading = false
        encryptionLoading = false
        loaded = false
        backupDir = ""
        backupOnQuit = false
        encryptionStatus = nil
        reminderDismissed = false
        restoreFile = ""
        backupPassphrase = ""
        pendingConfirmationFile = nil
        pendingRestoreFile = nil
        restorePassphrase = ""
        restoreSubmitting = false
        restoreRunning = false
    }
    private func enqueue(
        _ key: String, kind: ScreenNotice.Kind = .success, variables: [String: String] = [:], detail: String? = nil
    ) {
        noticeID += 1
        let notice = ScreenNotice(id: noticeID, kind: kind, key: key, variables: variables, detail: detail)
        if let didNotice { didNotice(notice) } else { notices.append(notice) }
    }
    public func clearNotice(_ id: Int) { notices.removeAll { $0.id == id } }
}
