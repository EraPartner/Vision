import Foundation
import Testing
@testable import VisionNativeCore

@Suite struct BridgeCodecTests {
    private func request(_ channel: BridgeChannel, _ arguments: [JSONValue] = []) -> BridgeRequest {
        BridgeRequest(channel: channel, arguments: arguments)
    }

    @Test func decodesChannelAndArguments() {
        #expect(
            BridgeCodec.decode(#"{"channel":"app:set-badge","args":[3]}"#)
                == .request(request(.setBadge, [.int(3)])))
        #expect(BridgeCodec.decode(#"{"channel":"app:renderer-ready"}"#) == .request(request(.rendererReady)))
    }

    @Test func refusesMalformedAndUnknownMessages() {
        for body in [nil, "", "[]", "42", #"{"args":[]}"#, #"{"channel":7}"#, #"{"channel":"app:set-badge","args":{}}"#] {
            #expect(BridgeCodec.decode(body) == .invalid(BridgeCodec.malformedMessage), "\(body ?? "nil")")
        }
        #expect(BridgeCodec.decode(#"{"channel":"shell:exec","args":[]}"#) == .invalid(BridgeCodec.unknownChannelMessage))
        let oversized = #"{"channel":"app:renderer-ready","args":[""# + String(repeating: "x", count: 70_000) + #""]}"#
        #expect(BridgeCodec.decode(oversized) == .invalid(BridgeCodec.malformedMessage))
    }

    @Test func payloadChannelsAcceptLargerMessages() {
        // runBackup(destDir, frontendStateJson) carries the localStorage snapshot.
        let snapshot = String(repeating: "x", count: 100 * 1024)
        let backup = #"{"channel":"backup:run","args":["/Users/me/Backups",""# + snapshot + #""]}"#
        #expect(backup.utf8.count > BridgeContract.maximumMessageBytes)
        #expect(
            BridgeCodec.decode(backup)
                == .request(request(.backupRun, [.string("/Users/me/Backups"), .string(snapshot)])))
        #expect(BridgeContract.maximumMessageBytes(for: .backupRun) == 8 * 1024 * 1024)
        #expect(BridgeContract.maximumMessageBytes(for: .setBadge) == 64 * 1024)
        // The same size on a small-message channel is still refused.
        let small = #"{"channel":"app:set-badge","args":[""# + snapshot + #""]}"#
        #expect(BridgeCodec.decode(small) == .invalid(BridgeCodec.malformedMessage))
        // Nothing above the payload limit is parsed, whatever the channel.
        let huge = #"{"channel":"backup:run","args":["/tmp",""# + String(repeating: "x", count: 8 * 1024 * 1024) + #""]}"#
        #expect(BridgeCodec.decode(huge) == .invalid(BridgeCodec.malformedMessage))
    }

    @Test func extraArgumentsAreRejected() {
        #expect(BridgeCodec.validate(request(.rendererReady, [.int(1)])) == .invalid(.failure))
        #expect(BridgeCodec.validate(request(.rendererReady, [.null])) == .call(.rendererReady))
        #expect(
            BridgeCodec.validate(request(.servicesLoadSettings, [.bool(true)]))
                == .invalid(.reject("Invalid arguments for services:load-settings")))
        #expect(BridgeCodec.validate(request(.getAccentColor, [.int(1)])) == .invalid(.resolve(.null)))
    }

    @Test func badgeCountIsCoercedAndClamped() {
        #expect(BridgeCodec.validate(request(.setBadge, [.int(4)])) == .call(.setBadge(4)))
        #expect(BridgeCodec.validate(request(.setBadge, [.double(7.9)])) == .call(.setBadge(7)))
        #expect(BridgeCodec.validate(request(.setBadge, [.int(5000)])) == .call(.setBadge(999)))
        #expect(BridgeCodec.validate(request(.setBadge, [.int(-3)])) == .call(.setBadge(0)))
        #expect(BridgeCodec.validate(request(.setBadge, [.string("12")])) == .call(.setBadge(12)))
        #expect(BridgeCodec.validate(request(.setBadge, [.string("many")])) == .invalid(.failure))
        #expect(BridgeCodec.validate(request(.setBadge, [.object([:])])) == .invalid(.failure))
    }

    @Test func aMissingBadgeCountIsInvalidNotZero() {
        // Number(undefined) is NaN in Electron; JSON.stringify sends undefined as null.
        #expect(BridgeCodec.validate(request(.setBadge)) == .invalid(.failure))
        #expect(BridgeCodec.validate(request(.setBadge, [.null])) == .invalid(.failure))
        #expect(BridgeCodec.validate(request(.setBadge, [.int(0)])) == .call(.setBadge(0)))
    }

    @Test func backupSettingsFollowBackupSettingsArguments() {
        #expect(
            BridgeCodec.validate(
                request(.backupSaveSettings, [.object(["backupDir": .string("/Users/me/Backups"), "backupOnQuit": .bool(true)])]))
                == .call(.saveBackupSettings(BackupSettingsValue(backupDir: "/Users/me/Backups", backupOnQuit: true))))
        #expect(
            BridgeCodec.validate(request(.backupSaveSettings, [.object(["backupDir": .string(""), "backupOnQuit": .bool(false)])]))
                == .call(.saveBackupSettings(BackupSettingsValue(backupDir: "", backupOnQuit: false))))
        #expect(
            BridgeCodec.validate(request(.backupSaveSettings, [.object(["backupDir": .string("/x"), "backupOnQuit": .string("yes")])]))
                == .invalid(.failed("Invalid backup settings")))
        #expect(
            BridgeCodec.validate(request(.backupSaveSettings, [.object(["backupDir": .string("/etc/../Library/x"), "backupOnQuit": .bool(true)])]))
                == .invalid(.failed("Backup to system directories is not allowed")))
        #expect(
            BridgeCodec.validate(request(.backupSaveSettings, [.object(["backupDir": .string("Backups"), "backupOnQuit": .bool(true)])]))
                == .invalid(.failed("Backup directory must be an absolute path")))
        #expect(BridgeCodec.validate(request(.backupLoadSettings)) == .call(.loadBackupSettings))
        #expect(
            BridgeCodec.validate(request(.backupLoadSettings, [.int(1)]))
                == .invalid(.reject("Invalid arguments for backup:load-settings")))
    }

    @Test func backupDestinationsMatchValidateBackupDest() {
        #expect(BackupSettings.destinationError("/Users/me/Library/Mobile Documents/Vision") == nil)
        #expect(BackupSettings.destinationError("/Volumes/Backup") == nil)
        #expect(BackupSettings.destinationError("/Libraryish") == nil)
        for blocked in ["/System", "/usr/local", "/private/etc/x", "/Library/", "/Users/../etc", "//bin"] {
            #expect(BackupSettings.destinationError(blocked) == "Backup to system directories is not allowed", "\(blocked)")
        }
        #expect(BackupSettings.normalizedPath("/a/./b/../c//") == "/a/c")
        #expect(BackupSettings.normalizedPath("/..") == "/")
    }

    @Test func languageAndVibrancyAreStrict() {
        #expect(BridgeCodec.validate(request(.setLanguage, [.string("nl")])) == .call(.setLanguage(.nl)))
        #expect(BridgeCodec.validate(request(.setLanguage, [.string("fr")])) == .invalid(.failure))
        #expect(BridgeCodec.validate(request(.setVibrancy, [.bool(true)])) == .call(.setVibrancy(true)))
        #expect(BridgeCodec.validate(request(.setVibrancy, [.string("true")])) == .invalid(.failure))
    }

    @Test func splashThemeMustBeHSLComponents() {
        let valid: JSONValue = .object([
            "mode": .string("light"), "background": .string("158 64% 52%"), "foreground": .string("0 0% 100%"),
            "surface": .string("210 40% 98%"), "text": .null,
        ])
        #expect(
            BridgeCodec.validate(request(.persistSplashTheme, [valid]))
                == .call(
                    .persistSplashTheme(
                        SplashTheme(
                            mode: .light, background: "158 64% 52%", foreground: "0 0% 100%", surface: "210 40% 98%"))))
        for background in ["red", "158 64% 52%; }", "158 64% 52%\n", "１５８ 64% 52%", "1580 64% 52%"] {
            let invalid: JSONValue = .object(["background": .string(background), "foreground": .string("0 0% 100%")])
            #expect(BridgeCodec.validate(request(.persistSplashTheme, [invalid])) == .invalid(.failure), "\(background)")
        }
        let badMode: JSONValue = .object([
            "mode": .string("sepia"), "background": .string("158 64% 52%"), "foreground": .string("0 0% 100%"),
        ])
        #expect(BridgeCodec.validate(request(.persistSplashTheme, [badMode])) == .invalid(.failure))
    }

    @Test func servicesSettingsNeedABoolean() {
        #expect(
            BridgeCodec.validate(request(.servicesSaveSettings, [.object(["keepServicesOnQuit": .bool(true)])]))
                == .call(.saveServicesSettings(keepServicesOnQuit: true)))
        #expect(
            BridgeCodec.validate(request(.servicesSaveSettings, [.object(["keepServicesOnQuit": .string("yes")])]))
                == .invalid(.failed("Invalid services settings")))
    }

    @Test func rendererFailuresCollapseToPlaceholders() {
        let clean = BridgeCodec.rendererFailure(
            .object([
                "kind": .string("resource"), "name": .string("ResourceLoadError"), "source": .string("index-abc.js"),
                "line": .int(12),
            ]))
        #expect(clean == RendererFailure(kind: "resource", name: "ResourceLoadError", source: "index-abc.js", line: 12))
        let hostile = BridgeCodec.rendererFailure(
            .object([
                "kind": .string("bogus"), "name": .string("secret value with spaces"),
                "source": .string("https://example.com/a?token=1"), "line": .double(1.5),
            ]))
        #expect(hostile == RendererFailure(kind: "error", name: "UnknownError", source: "unknown", line: 0))
        #expect(BridgeCodec.rendererFailure(nil) == RendererFailure(kind: "error", name: "UnknownError", source: "unknown", line: 0))
        #expect(
            BridgeCodec.validate(request(.rendererFailure, [.string("x"), .int(1)]))
                == .call(.rendererFailure(RendererFailure(kind: "error", name: "UnknownError", source: "unknown", line: 0))))
    }

    @Test func pendingAndRemovedChannelsSkipValidation() {
        #expect(BridgeCodec.validate(request(.backupRun, [.string("/etc"), .int(1), .int(2)])) == .call(.unavailable(.backupRun)))
        #expect(BridgeCodec.validate(request(.backupSelectFile)) == .call(.unavailable(.backupSelectFile)))
        #expect(BridgeCodec.validate(request(.backupRestore, [.string("/x.visionbak")])) == .call(.unavailable(.backupRestore)))
        #expect(BridgeCodec.validate(request(.auditRead)) == .call(.unavailable(.auditRead)))
        #expect(BridgeCodec.validate(request(.updateCheckGithub)) == .call(.unavailable(.updateCheckGithub)))
    }

    @Test func repliesAreJSONTextOrAnErrorMessage() {
        #expect(BridgeReply.success.scriptReply.result == #"{"success":true}"#)
        #expect(BridgeReply.success.scriptReply.error == nil)
        #expect(BridgeReply.resolve(.null).scriptReply.result == "null")
        #expect(BridgeReply.resolve(.string("0a84ffff")).scriptReply.result == #""0a84ffff""#)
        #expect(BridgeReply.reject("nope").scriptReply.result == nil)
        #expect(BridgeReply.reject("nope").scriptReply.error == "nope")
        #expect(BridgeReply.failed("x").scriptReply.result == #"{"error":"x","success":false}"#)
    }
}
