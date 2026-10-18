import Foundation

/// The invoke channels of `ElectronInvokeContract` (packaging/electron/electron-api.d.ts),
/// plus three Vision Native channels: two for the topbar drag region and the router
/// report of the native navigation shell.
public enum BridgeChannel: String, CaseIterable, Sendable {
    case updateCheckGithub = "update:check-github"
    case updateInstallShell = "update:install-shell"
    case updatePreUpdateBackup = "update:pre-update-backup"
    case backupRun = "backup:run"
    case backupSelectDir = "backup:select-dir"
    case backupSelectFile = "backup:select-file"
    case backupRestore = "backup:restore"
    case backupIsEncrypted = "backup:is-encrypted"
    case backupSaveSettings = "backup:save-settings"
    case backupLoadSettings = "backup:load-settings"
    case backupGetEncryptionStatus = "backup:get-encryption-status"
    case backupSetPassphrase = "backup:set-passphrase"
    case servicesSaveSettings = "services:save-settings"
    case servicesLoadSettings = "services:load-settings"
    case auditEnroll = "audit:enroll"
    case auditRead = "audit:read"
    case auditExport = "audit:export"
    case auditTransferExport = "audit:transfer-export"
    case auditTransferImport = "audit:transfer-import"
    case auditRotateKey = "audit:rotate-key"
    case recoveryRetry = "recovery:retry"
    case recoveryOpenLogs = "recovery:open-logs"
    case rendererFailure = "app:renderer-failure"
    case rendererReady = "app:renderer-ready"
    case setBadge = "app:set-badge"
    case setLanguage = "app:set-language"
    case setVibrancy = "app:set-vibrancy"
    case getAccentColor = "app:get-accent-color"
    case persistSplashTheme = "theme:persist-splash"
    // `-webkit-app-region: drag` has no WebKit equivalent, so the user script reports a
    // mouse-down on the topbar and the shell starts the window drag.
    case windowDrag = "native:window-drag"
    case windowTitlebarDoubleClick = "native:window-titlebar-double-click"
    // The page's router reports `pathname + search` to the native sidebar (phase 2).
    case routeChanged = "shell:route-changed"
}

/// The channels of `ElectronEventContract`, sent from the shell to the page.
public enum BridgeEvent: String, CaseIterable, Sendable {
    case accentColorChanged = "app:accent-color-changed"
    case menuAction = "menu:action"
    case csvOpened = "app:csv-opened"
    case fullScreen = "window:fullscreen"
    case backendLost = "backend:lost"
    case backendRestored = "backend:restored"
}

public enum BridgeAvailability: Equatable, Sendable {
    /// Answered by Vision Native (phase 1c, backup and restore since phase 1d, the audit
    /// channels since phase 1e).
    case implemented
    /// Rejects with `BridgeContract.unavailableMessage` until the named phase ports it. No
    /// channel is pending after phase 1e; the case stays for later phases.
    case pending(phase: String)
    /// Not part of Vision Native (ADR-204 decision 5 cuts the updater); the user script
    /// does not define the method, and a direct call rejects.
    case removed
    /// A Vision Native channel with no Electron counterpart.
    case nativeOnly
}

/// One row of the Electron channel → Swift handler table.
public struct BridgeEntry: Equatable, Sendable {
    public let channel: BridgeChannel
    /// The `window.<bridge>` object that exposes the method.
    public let bridge: String
    /// The method name in preload.ts; `nil` for native-only channels the user script calls
    /// itself. A native-only channel with a method is exposed only by Vision Native.
    public let method: String?
    /// The parameter names the method passes, in order (its arity).
    public let parameters: [String]
    /// The `BridgeHost` requirement that answers it.
    public let handler: String
    public let availability: BridgeAvailability
}

/// The Swift side of the preload contract. `BridgeScript` generates the page's `window.*`
/// objects from `entries`, and `BridgeDispatcher` answers each message.
public enum BridgeContract {
    /// `window.webkit.messageHandlers.<name>`.
    public static let messageHandlerName = "visionNative"
    /// `electronAPI.platform`; the frontend keys the macOS chrome CSS on it.
    public static let platform = "darwin"
    /// The default message limit. Renderer messages are small JSON.
    public static let maximumMessageBytes = 64 * 1024
    /// The limit of channels that carry a payload: `backup:run` sends the localStorage
    /// snapshot (`frontendStateJson`), which can exceed 64 KiB. No message is parsed above it.
    public static let maximumPayloadMessageBytes = 8 * 1024 * 1024
    public static let payloadChannels: Set<BridgeChannel> = [.backupRun]

    /// The largest message the shell accepts on a channel.
    public static func maximumMessageBytes(for channel: BridgeChannel) -> Int {
        payloadChannels.contains(channel) ? maximumPayloadMessageBytes : maximumMessageBytes
    }

    private static func entry(
        _ channel: BridgeChannel, _ bridge: String, _ method: String?, _ parameters: [String] = [],
        _ handler: String, _ availability: BridgeAvailability
    ) -> BridgeEntry {
        BridgeEntry(
            channel: channel, bridge: bridge, method: method, parameters: parameters, handler: handler,
            availability: availability)
    }

    public static let entries: [BridgeEntry] = [
        entry(.updateCheckGithub, "electronUpdater", "checkRelease", [], "none (updater cut)", .removed),
        entry(.updateInstallShell, "electronUpdater", "installShellUpdate", [], "none (updater cut)", .removed),
        entry(.updatePreUpdateBackup, "electronUpdater", "preUpdateBackup", [], "none (updater cut)", .removed),
        entry(.backupRun, "electronBackup", "runBackup", ["destDir", "frontendStateJson"], "runBackup", .implemented),
        entry(.backupSelectDir, "electronBackup", "selectDir", [], "selectBackupDirectory", .implemented),
        entry(.backupSelectFile, "electronBackup", "selectFile", [], "selectRestoreFile", .implemented),
        entry(.backupRestore, "electronBackup", "restoreBackup", ["filePath", "opts"], "restoreBackup", .implemented),
        entry(.backupIsEncrypted, "electronBackup", "isEncrypted", ["filePath"], "isBackupEncrypted", .implemented),
        entry(
            .backupSaveSettings, "electronBackup", "saveSettings", ["settings"], "saveBackupSettings",
            .implemented),
        entry(.backupLoadSettings, "electronBackup", "loadSettings", [], "loadBackupSettings", .implemented),
        entry(
            .backupGetEncryptionStatus, "electronBackup", "getEncryptionStatus", [], "backupEncryptionStatus",
            .implemented),
        entry(
            .backupSetPassphrase, "electronBackup", "setPassphrase", ["passphrase"], "setBackupPassphrase",
            .implemented),
        entry(
            .servicesSaveSettings, "electronServices", "saveSettings", ["settings"], "saveServicesSettings",
            .implemented),
        entry(.servicesLoadSettings, "electronServices", "loadSettings", [], "loadServicesSettings", .implemented),
        entry(.auditEnroll, "electronAudit", "enroll", [], "enrollAudit", .implemented),
        entry(.auditRead, "electronAudit", "read", ["options"], "readAudit", .implemented),
        entry(.auditExport, "electronAudit", "exportSnapshot", [], "exportAuditSnapshot", .implemented),
        entry(
            .auditTransferExport, "electronAudit", "exportTransfer", ["password"], "exportAuditTransfer",
            .implemented),
        entry(
            .auditTransferImport, "electronAudit", "importTransfer", ["password"], "importAuditTransfer",
            .implemented),
        entry(.auditRotateKey, "electronAudit", "rotateKey", [], "rotateAuditKey", .implemented),
        entry(.recoveryRetry, "electronRecovery", "retry", [], "retryLaunch", .implemented),
        entry(.recoveryOpenLogs, "electronRecovery", "openLogs", [], "openLogs", .implemented),
        entry(.rendererFailure, "", nil, ["payload"], "rendererDidFail (user script listeners)", .implemented),
        entry(.rendererReady, "electronAPI", "ready", [], "rendererDidBecomeReady", .implemented),
        entry(.setBadge, "electronAPI", "setDockBadge", ["count"], "setDockBadge", .implemented),
        entry(.setLanguage, "electronAPI", "setLanguage", ["language"], "setLanguage", .implemented),
        entry(.setVibrancy, "electronAPI", "setVibrancy", ["enabled"], "setVibrancy", .implemented),
        entry(.getAccentColor, "electronAPI", "getAccentColor", [], "accentColor", .implemented),
        entry(
            .persistSplashTheme, "electronAPI", "persistSplashTheme", ["colors"], "persistSplashTheme",
            .implemented),
        entry(.windowDrag, "", nil, [], "startWindowDrag", .nativeOnly),
        entry(.windowTitlebarDoubleClick, "", nil, [], "titlebarDoubleClicked", .nativeOnly),
        entry(.routeChanged, "electronAPI", "routeChanged", ["route"], "routeDidChange", .nativeOnly),
    ]

    public static func entry(for channel: BridgeChannel) -> BridgeEntry {
        // Every case has exactly one row (BridgeContractTests).
        entries.first { $0.channel == channel }!
    }

    /// The `window.*` objects the user script defines, in preload.ts order.
    public static let bridges = [
        "electronUpdater", "electronBackup", "electronAudit", "electronServices", "electronAPI", "electronRecovery",
    ]

    /// The rejection for a channel Vision Native does not answer.
    public static func unavailableMessage(_ entry: BridgeEntry) -> String {
        let name = entry.method.map { "\(entry.bridge).\($0)" } ?? entry.channel.rawValue
        switch entry.availability {
        case .pending(let phase):
            return "\(name) is not available in Vision Native yet (phase \(phase))."
        case .removed:
            return "\(name) is not part of Vision Native: it has no updater. Rerun install-native.sh to update."
        case .implemented, .nativeOnly:
            return "\(name) is not available."
        }
    }
}
