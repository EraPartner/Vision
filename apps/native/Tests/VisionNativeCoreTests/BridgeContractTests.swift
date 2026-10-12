import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct BridgeContractTests {
    /// The methods of each bridge in packaging/electron/preload.ts and their channels.
    static let preloadMethods: [String: [String: String]] = [
        "electronUpdater": [
            "checkRelease": "update:check-github",
            "installShellUpdate": "update:install-shell",
            "preUpdateBackup": "update:pre-update-backup",
        ],
        "electronBackup": [
            "runBackup": "backup:run",
            "selectDir": "backup:select-dir",
            "selectFile": "backup:select-file",
            "restoreBackup": "backup:restore",
            "isEncrypted": "backup:is-encrypted",
            "saveSettings": "backup:save-settings",
            "loadSettings": "backup:load-settings",
            "getEncryptionStatus": "backup:get-encryption-status",
            "setPassphrase": "backup:set-passphrase",
        ],
        "electronAudit": [
            "enroll": "audit:enroll",
            "read": "audit:read",
            "exportSnapshot": "audit:export",
            "exportTransfer": "audit:transfer-export",
            "importTransfer": "audit:transfer-import",
            "rotateKey": "audit:rotate-key",
        ],
        "electronServices": ["saveSettings": "services:save-settings", "loadSettings": "services:load-settings"],
        "electronAPI": [
            "ready": "app:renderer-ready",
            "setDockBadge": "app:set-badge",
            "setLanguage": "app:set-language",
            "setVibrancy": "app:set-vibrancy",
            "getAccentColor": "app:get-accent-color",
            "persistSplashTheme": "theme:persist-splash",
        ],
        "electronRecovery": ["retry": "recovery:retry", "openLogs": "recovery:open-logs"],
    ]

    @Test func everyChannelHasExactlyOneRow() {
        for channel in BridgeChannel.allCases {
            #expect(BridgeContract.entries.filter { $0.channel == channel }.count == 1, "\(channel.rawValue)")
        }
        #expect(BridgeContract.entries.count == BridgeChannel.allCases.count)
    }

    @Test func theElectronInvokeContractHas29Channels() {
        // ipc-contract.test.ts: `assert.equal(declared.size, 29)`.
        let electron = BridgeContract.entries.filter { $0.availability != .nativeOnly }
        #expect(electron.count == 29)
        #expect(electron.allSatisfy { !$0.channel.rawValue.hasPrefix("native:") })
        #expect(BridgeEvent.allCases.count == 6)
    }

    @Test func tableMatchesThePreloadMethodNames() {
        var table: [String: [String: String]] = [:]
        for entry in BridgeContract.entries {
            guard let method = entry.method else { continue }
            table[entry.bridge, default: [:]][method] = entry.channel.rawValue
        }
        #expect(table == Self.preloadMethods)
        #expect(Set(BridgeContract.bridges) == Set(Self.preloadMethods.keys))
    }

    @Test func availabilityFollowsThePhasePlan() {
        for entry in BridgeContract.entries {
            switch entry.bridge {
            case "electronUpdater": #expect(entry.availability == .removed)
            case "electronBackup": #expect(entry.availability == .pending(phase: "1d"))
            case "electronAudit": #expect(entry.availability == .pending(phase: "1e"))
            case "electronServices", "electronAPI", "electronRecovery": #expect(entry.availability == .implemented)
            default: #expect(entry.method == nil)
            }
        }
    }

    @Test func unavailableMessagesNameTheMethodAndPhase() {
        let backup = BridgeContract.unavailableMessage(BridgeContract.entry(for: .backupRun))
        #expect(backup == "electronBackup.runBackup is not available in Vision Native yet (backup and restore arrive in phase 1d).")
        let audit = BridgeContract.unavailableMessage(BridgeContract.entry(for: .auditRead))
        #expect(audit.contains("not available in Vision Native yet") && audit.contains("phase 1e"))
        let updater = BridgeContract.unavailableMessage(BridgeContract.entry(for: .updateCheckGithub))
        #expect(updater.contains("no updater"))
    }

    @Test func userScriptDefinesEveryBridgeAndMethodExceptTheUpdater() {
        let source = BridgeScript.source
        for bridge in BridgeContract.bridges {
            #expect(source.contains("expose(\"\(bridge)\", {"), "\(bridge)")
        }
        for (bridge, methods) in Self.preloadMethods where bridge != "electronUpdater" {
            for (method, channel) in methods {
                #expect(source.contains("    \(method): ("), "\(bridge).\(method)")
                #expect(source.contains("invoke(\"\(channel)\""), "\(channel)")
            }
        }
        for method in ["checkRelease", "installShellUpdate", "preUpdateBackup"] {
            #expect(!source.contains("\(method):"), "\(method)")
        }
        for subscription in [
            "onAccentColorChanged", "onMenuAction", "onCsvOpen", "onFullScreenChange", "onBackendLost",
            "onBackendRestored",
        ] {
            #expect(source.contains("    \(subscription): "), "\(subscription)")
        }
        #expect(source.contains("platform: \"darwin\""))
        #expect(source.contains("handlers.\(BridgeContract.messageHandlerName)"))
        #expect(source.contains("\"app:renderer-failure\""))
    }

    @Test func scriptMethodsPassTheirDeclaredArity() {
        #expect(BridgeScript.methods(for: "electronBackup").contains(
            "    runBackup: (destDir, frontendStateJson) => invoke(\"backup:run\", [destDir, frontendStateJson]),"))
        #expect(BridgeScript.methods(for: "electronAPI").contains(
            "    setDockBadge: (count) => invoke(\"app:set-badge\", [count]),"))
        #expect(BridgeScript.methods(for: "electronAPI").contains(
            "    ready: () => invoke(\"app:renderer-ready\", []),"))
        #expect(BridgeScript.methods(for: "electronUpdater").isEmpty)
    }
}
