import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native settings backup host contracts and receipt scopes") @MainActor
struct NativeSettingsBackupTests {
    @Test func onboardingRestoreOnlyReadsNoBackupPreferencesAndCompletesAfterApplyingFrontendState() async {
        let host = BackupDesktopFixture()
        host.restoreReceipts = [.object([
            "success": .bool(true), "frontendState": .object(["keys": .object(["synthetic": .string("value")])]),
        ])]
        let model = NativeSettingsBackupModel(service: host, reloadDelay: .milliseconds(1))
        model.didRestore = { host.events.append("complete") }
        model.activateRestoreOnly()
        model.activateRestoreOnly()
        await model.startRestore(file: "/synthetic/onboarding.visionbak")
        #expect(host.preferenceReads.isEmpty)
        #expect(host.events.prefix(2) == ["apply", "complete"])
        #expect(host.restoreCalls.count == 1 && model.pendingRestoreFile == nil)
        await host.waitForReload()
        #expect(host.events == ["apply", "complete", "reload"])
    }
    @Test func unreadSettingsNeverPersistDefaultsAndLateReadCannotPublishAfterLeave() async throws {
        let host = BackupDesktopFixture()
        host.settingsFails = true
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        #expect(!model.loaded)
        model.setBackupOnQuit(true)
        await model.flushSettings()
        #expect(host.savedSettings.isEmpty)
        host.settingsFails = false
        model.didDisappear()
        host.pauseSettings = true
        let loading = Task { await model.load() }
        await host.waitForSettingsRead()
        model.didDisappear()
        host.releaseSettingsRead()
        await loading.value
        #expect(!model.loaded && model.backupDir.isEmpty)
        #expect(host.savedSettings.isEmpty)
    }
    @Test func pickerCancellationPreservesSelectionAndQuitWritesSerializeConcreteLatestValues() async throws {
        let host = BackupDesktopFixture()
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        await model.browseDirectory()
        #expect(model.backupDir == "/synthetic/backups")
        #expect(host.savedSettings.isEmpty)
        host.directoryPick = "/synthetic/chosen"
        await model.browseDirectory()
        await model.flushSettings()
        #expect(host.savedSettings.last == .init(backupDir: "/synthetic/chosen", backupOnQuit: false))
        host.pauseSave = true
        model.setBackupOnQuit(true)
        await host.waitForSave()
        model.setBackupOnQuit(false)
        host.releaseSave()
        await model.flushSettings()
        #expect(host.savedSettings.suffix(2).map(\.backupOnQuit) == [true, false])
        #expect(host.savedSettings.last?.backupDir == "/synthetic/chosen")
        host.filePick = "/synthetic/kept.visionbak"
        await model.selectRestoreFile()
        host.filePick = nil
        await model.selectRestoreFile()
        #expect(model.restoreFile == "/synthetic/kept.visionbak")
    }
    @Test func backupForwardsExactFrontendSnapshotAndPublishesSourceSuccessWarningCleanup() async throws {
        let host = BackupDesktopFixture()
        host.backupReceipt = .object([
            "success": .bool(true), "file": .string("/synthetic/result.visionbak"),
            "warning": .string("Synthetic warning"), "cleanupRemoved": .int(2),
        ])
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        await model.runBackup()
        #expect(host.backupCalls.first?.directory == "/synthetic/backups")
        #expect(host.backupCalls.first?.state == host.frontendSnapshot)
        #expect(
            model.notices.map(\.key) == [
                "settings.backup.success", "Synthetic warning", "settings.backup.cleanupRemoved",
            ])
        #expect(model.notices.first?.variables["file"] == "/synthetic/result.visionbak")
        #expect(model.notices.last?.variables["count"] == "2")
        host.captureFails = true
        await model.runBackup()
        #expect(host.backupCalls.last?.state == nil)
        #expect(!model.backupRunning)
    }
    @Test func encryptionStatusPrecedenceAndRawPassphraseSaveClearAndReminderMatchSource() async throws {
        let host = BackupDesktopFixture()
        host.encryption = .init(hasEnvPassphrase: true, hasStoredPassphrase: true, secureStorageAvailable: true)
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        #expect(model.passphraseStatusKey == "settings.backup.passphrase.statusEnv")
        await model.dismissReminder()
        #expect(!model.showsReminder)
        model.backupPassphrase = "  synthetic fixture password  "
        await model.savePassphrase()
        #expect(host.passphrases == ["  synthetic fixture password  "])
        #expect(model.backupPassphrase.isEmpty)
        #expect(model.showsReminder)
        #expect(host.reminderWrites == [true, false])
        await model.clearPassphrase()
        #expect(host.passphrases.last == "")
        #expect(model.notices.last?.key == "settings.backup.passphrase.cleared")
    }
    @Test func sourceEcmascriptTrimClassifiesBomAndNelWithoutChangingPasswordBytes() async throws {
        let host = BackupDesktopFixture()
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        model.backupPassphrase = "\u{FEFF}"
        await model.savePassphrase()
        #expect(host.passphrases.last == "\u{FEFF}")
        #expect(model.notices.last?.key == "settings.backup.passphrase.cleared")
        model.backupPassphrase = "\u{0085}"
        await model.savePassphrase()
        #expect(host.passphrases.last == "\u{0085}")
        #expect(
            model.notices.suffix(2).map(\.key) == [
                "settings.backup.passphrase.saved", "settings.backup.passphrase.reminderTitle",
            ])
    }
    @Test func unavailableOrFailedPassphraseReceiptKeepsDraftAndUnknownStatusDisablesWrites() async throws {
        let host = BackupDesktopFixture()
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        model.backupPassphrase = "synthetic unsaved"
        host.passphraseReceipt = .init(success: false, available: true, error: "Synthetic failure")
        await model.savePassphrase()
        #expect(model.backupPassphrase == "synthetic unsaved")
        #expect(model.notices.last?.key == "settings.backup.passphrase.saveFailed")
        host.passphraseReceipt = nil
        await model.savePassphrase()
        #expect(model.notices.last?.key == "settings.backup.passphrase.unavailable")
        model.didDisappear()
        host.encryption = nil
        await model.load()
        let writes = host.passphrases.count
        await model.clearPassphrase()
        #expect(host.passphrases.count == writes)
        #expect(model.passphraseStatusKey == "settings.backup.passphrase.statusUnknown")
    }
    @Test func lateReminderReadCannotUndoUserDismissal() async throws {
        let host = BackupDesktopFixture()
        host.pauseReminder = true
        let model = NativeSettingsBackupModel(service: host)
        let loading = Task { await model.load() }
        await host.waitForReminderRead()
        await model.dismissReminder()
        host.releaseReminderRead()
        await loading.value
        #expect(model.reminderDismissed)
        #expect(host.reminderWrites == [true])
    }
    @Test func restoreConfirmationCancellationNeverCallsProbeOrRestoreAndRetainsPickedFile() async throws {
        let host = BackupDesktopFixture()
        host.filePick = "/synthetic/picked.enc"
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        await model.selectRestoreFile()
        model.requestRestoreConfirmation()
        model.cancelRestoreConfirmation()
        await model.confirmRestore()
        #expect(host.probedFiles.isEmpty && host.restoreCalls.isEmpty)
        #expect(model.restoreFile == "/synthetic/picked.enc")
    }
    @Test func encryptedRestorePromptsRetriesInvalidPasswordAndAppliesSourceStateBeforeDelayedReload() async throws {
        let host = BackupDesktopFixture()
        host.encrypted = true
        host.restoreReceipts = [
            .object(["success": .bool(false), "error": .string("Error: INVALID_PASSPHRASE")]),
            .object([
                "success": .bool(true), "file": .string("restored.enc"),
                "frontendState": .object([
                    "keys": .object(["vision.analysis.sqlHistory": .string("[\"SELECT synthetic\"]")])
                ]),
            ]),
        ]
        let model = NativeSettingsBackupModel(service: host, reloadDelay: .milliseconds(1))
        await model.load()
        await model.startRestore(file: "/synthetic/restored.enc")
        #expect(model.restorePassphrasePresented && host.restoreCalls.isEmpty)
        model.restorePassphrase = "wrong fixture"
        await model.submitRestorePassphrase()
        #expect(model.restorePassphrasePresented && model.restorePassphrase.isEmpty)
        #expect(model.notices.last?.key == "settings.restore.passphraseInvalid")
        model.restorePassphrase = "correct fixture"
        await model.submitRestorePassphrase()
        #expect(host.restoreCalls.map(\.passphrase) == ["wrong fixture", "correct fixture"])
        #expect(host.appliedStates.count == 1)
        #expect(!model.restorePassphrasePresented && !model.restoreRunning)
        for _ in 0..<1000 {
            if host.reloads == 1 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(host.reloads == 1)
        #expect(host.events.firstIndex(of: "apply")! < host.events.firstIndex(of: "reload")!)
        #expect(model.notices.last?.variables["file"] == "restored.enc")
    }
    @Test func probeFailureUsesActualWrapperFallbackAndRequiredReceiptOpensPasswordWithoutClaimingSuccess() async throws
    {
        let host = BackupDesktopFixture()
        host.probeFails = true
        host.restoreReceipts = [.object(["success": .bool(false), "error": .string("PASSPHRASE_REQUIRED")])]
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        await model.startRestore(file: "/synthetic/defensive.enc")
        #expect(host.restoreCalls.count == 1)
        #expect(model.pendingRestoreFile == "/synthetic/defensive.enc")
        #expect(!model.notices.contains { $0.key == "settings.restore.success" })
        model.cancelRestorePassphrase()
        #expect(!model.restoreRunning && !model.restorePassphrasePresented)
    }
    @Test func newerSchemaAndOrdinaryFailureKeepSourceNoticeDetailsAndPermitRetry() async throws {
        let host = BackupDesktopFixture()
        host.restoreReceipts = [
            .object([
                "success": .bool(false), "error": .string("Error: BUNDLE_SCHEMA_NEWER: Synthetic schema is newer"),
            ])
        ]
        let model = NativeSettingsBackupModel(service: host)
        await model.load()
        await model.startRestore(file: "/synthetic/newer.visionbak")
        let notice = try #require(model.notices.last)
        #expect(notice.key == "settings.restore.schemaMismatch")
        #expect(notice.detail == "Synthetic schema is newer")
        #expect(NativeSettingsBackupNotice.lifetime(notice) == 12)
        #expect(!model.restoreRunning && host.reloads == 0)
    }
    @Test func oldRestoreReceiptAppliesAcceptedStateKeepsNewPromptAndSchedulesAuthoritativeGlobalReload() async throws {
        let host = BackupDesktopFixture()
        host.pauseRestore = true
        host.restoreReceipts = [
            .object(["success": .bool(true), "frontendState": .object(["keys": .object(["theme": .string("dark")])])])
        ]
        let model = NativeSettingsBackupModel(service: host, reloadDelay: .milliseconds(1))
        await model.load()
        let restoring = Task { await model.startRestore(file: "/synthetic/old.visionbak") }
        await host.waitForRestore()
        model.didDisappear()
        await model.load()
        host.encrypted = true
        await model.startRestore(file: "/synthetic/new.enc")
        model.restorePassphrase = "new pending fixture"
        host.releaseRestore()
        await restoring.value
        #expect(host.appliedStates.count == 1)
        #expect(model.pendingRestoreFile == "/synthetic/new.enc")
        #expect(model.restorePassphrase == "new pending fixture" && model.restoreRunning)
        for _ in 0..<1000 {
            if host.reloads == 1 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(host.reloads == 1)
    }
    @Test func noticesLocalizeDescriptionsHumanizeLegacyErrorsAndKeepExactLifetimes() throws {
        let strings = BackupFixtureStrings()
        let success = ScreenNotice(
            id: 1, kind: .success, key: "settings.restore.success", variables: ["file": "synthetic.enc"])
        #expect(
            NativeSettingsBackupNotice.detail(success, strings: strings)
                == "settings.restore.successDesc|file=synthetic.enc")
        #expect(NativeSettingsBackupNotice.lifetime(success) == 8)
        #expect(
            NativeSettingsBackupNotice.lifetime(
                .init(id: 2, kind: .info, key: "settings.backup.passphrase.reminderTitle")) == 10)
        #expect(
            NativeSettingsDesktopError.message(
                "Error: Error invoking remote method 'backup:run': Error: ENOENT /synthetic/file", strings: strings)
                == "electronError.notFound")
        #expect(
            NativeSettingsDesktopError.message("A readable synthetic failure", strings: strings)
                == "A readable synthetic failure")
        #expect(NativeSettingsDesktopError.newerSchemaDescription("not newer") == nil)
    }
    @Test func aboutUsesSourceIdentityLinksAndRestartReloadSurvivesClosingSettings() async throws {
        let host = BackupDesktopFixture()
        let model = NativeSettingsAboutModel(service: host, version: "synthetic.1", reloadDelay: .milliseconds(1))
        var urls: [URL] = []
        model.onOpenExternal = { urls.append($0) }
        model.openSource()
        model.openDocumentation()
        #expect(model.appName == "Vision" && model.license == "AGPL-3.0-only")
        #expect(
            urls.map(\.absoluteString) == [
                "https://github.com/EraPartner/Vision", "https://github.com/EraPartner/Vision/tree/main/docs",
            ])
        var restartCalls = 0
        model.onRestartOnboarding = { restartCalls += 1 }
        await model.restartOnboarding()
        #expect(restartCalls == 1)
        #expect(model.notices.last?.key == "settings.app.onboardingRestarted")
        for _ in 0..<1000 {
            if host.reloads == 1 { break }
            try await Task.sleep(for: .milliseconds(1))
        }
        #expect(host.reloads == 1)
    }
}
private struct BackupFixtureStrings: Localizing {
    let language: NativeLanguage = .en
    func t(_ key: String, _ variables: [String: String]) -> String {
        key + variables.keys.sorted().map { "|" + $0 + "=" + variables[$0]! }.joined()
    }
}
@MainActor private final class BackupDesktopFixture: NativeSettingsDesktopService {
    var preferenceReads: [String] = []
    private var reloadWaiter: CheckedContinuation<Void, Never>?
    func waitForReload() async {
        if reloads == 0 { await withCheckedContinuation { reloadWaiter = $0 } }
    }
    var isAvailable = true
    var settings = BackupSettingsValue(backupDir: "/synthetic/backups", backupOnQuit: false)
    var settingsFails = false
    var savedSettings: [BackupSettingsValue] = []
    var directoryPick: String?
    var filePick: String?
    var encryption: PassphraseStatus? = .init(
        hasEnvPassphrase: false, hasStoredPassphrase: false, secureStorageAvailable: true)
    var passphraseReceipt: PassphraseUpdateResult? = .init(success: true, available: true)
    var passphrases: [String] = []
    var frontendSnapshot = "{\"keys\":{\"vision.analysis.sqlHistory\":\"[]\"}}"
    var captureFails = false
    var backupReceipt: JSONValue? = .object(["success": .bool(true), "file": .string("synthetic.visionbak")])
    var backupCalls: [(directory: String, state: String?)] = []
    var encrypted = false
    var probeFails = false
    var probedFiles: [String] = []
    var restoreReceipts: [JSONValue?] = []
    var restoreCalls: [(file: String, passphrase: String?)] = []
    var appliedStates: [JSONValue] = []
    var reloads = 0
    var events: [String] = []
    var reminderDismissed = false
    var reminderWrites: [Bool] = []
    var pauseSettings = false
    var pauseReminder = false
    var pauseSave = false
    var pauseRestore = false
    private var settingsGate: CheckedContinuation<Void, Never>?
    private var settingsWaiter: CheckedContinuation<Void, Never>?
    private var reminderGate: CheckedContinuation<Void, Never>?
    private var reminderWaiter: CheckedContinuation<Void, Never>?
    private var saveGate: CheckedContinuation<Void, Never>?
    private var saveWaiter: CheckedContinuation<Void, Never>?
    private var restoreGate: CheckedContinuation<Void, Never>?
    private var restoreWaiter: CheckedContinuation<Void, Never>?
    func waitForSettingsRead() async {
        if settingsGate == nil { await withCheckedContinuation { settingsWaiter = $0 } }
    }
    func releaseSettingsRead() {
        settingsGate?.resume()
        settingsGate = nil
    }
    func waitForReminderRead() async {
        if reminderGate == nil { await withCheckedContinuation { reminderWaiter = $0 } }
    }
    func releaseReminderRead() {
        reminderGate?.resume()
        reminderGate = nil
    }
    func waitForSave() async { if saveGate == nil { await withCheckedContinuation { saveWaiter = $0 } } }
    func releaseSave() {
        saveGate?.resume()
        saveGate = nil
    }
    func waitForRestore() async { if restoreGate == nil { await withCheckedContinuation { restoreWaiter = $0 } } }
    func releaseRestore() {
        restoreGate?.resume()
        restoreGate = nil
    }
    func loadBackupSettings() async throws -> BackupSettingsValue {
        preferenceReads.append("settings")
        let snapshot = settings
        if pauseSettings {
            pauseSettings = false
            await withCheckedContinuation {
                settingsGate = $0
                settingsWaiter?.resume()
                settingsWaiter = nil
            }
        }
        if settingsFails { throw APIError.network("Synthetic settings failure") }
        return snapshot
    }
    func saveBackupSettings(_ settings: BackupSettingsValue) async throws {
        savedSettings.append(settings)
        if pauseSave {
            pauseSave = false
            await withCheckedContinuation {
                saveGate = $0
                saveWaiter?.resume()
                saveWaiter = nil
            }
        }
        self.settings = settings
    }
    func selectBackupDirectory() async throws -> String? { directoryPick }
    func selectBackupFile() async throws -> String? { filePick }
    func backupEncryptionStatus() async throws -> PassphraseStatus? {
        preferenceReads.append("status")
        return encryption
    }
    func setBackupPassphrase(_ passphrase: String) async throws -> PassphraseUpdateResult? {
        passphrases.append(passphrase)
        return passphraseReceipt
    }
    func captureFrontendState() async throws -> String? {
        if captureFails { throw APIError.network("Synthetic capture failure") }
        return frontendSnapshot
    }
    func runBackup(directory: String, frontendStateJSON: String?) async throws -> JSONValue? {
        backupCalls.append((directory, frontendStateJSON))
        return backupReceipt
    }
    func isBackupEncrypted(path: String) async throws -> Bool {
        probedFiles.append(path)
        if probeFails { throw APIError.network("Synthetic probe failure") }
        return encrypted
    }
    func restoreBackup(path: String, passphrase: String?) async throws -> JSONValue? {
        restoreCalls.append((path, passphrase))
        let receipt = restoreReceipts.isEmpty ? .object(["success": .bool(true)]) : restoreReceipts.removeFirst()
        if pauseRestore {
            pauseRestore = false
            await withCheckedContinuation {
                restoreGate = $0
                restoreWaiter?.resume()
                restoreWaiter = nil
            }
        }
        return receipt
    }
    func applyRestoredFrontendState(_ state: JSONValue) async throws {
        appliedStates.append(state)
        events.append("apply")
    }
    func reloadFrontend() async throws {
        reloads += 1
        events.append("reload")
        reloadWaiter?.resume()
        reloadWaiter = nil
    }
    func readBackupReminder() async throws -> Bool {
        preferenceReads.append("reminder")
        let snapshot = reminderDismissed
        if pauseReminder {
            pauseReminder = false
            await withCheckedContinuation {
                reminderGate = $0
                reminderWaiter?.resume()
                reminderWaiter = nil
            }
        }
        return snapshot
    }
    func writeBackupReminder(dismissed: Bool) async throws {
        reminderWrites.append(dismissed)
        reminderDismissed = dismissed
    }
}
