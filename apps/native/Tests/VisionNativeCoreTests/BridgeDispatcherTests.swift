import Foundation
import Testing
@testable import VisionNativeCore

@MainActor
final class RecordingBridgeHost: BridgeHost {
    var calls: [String] = []
    var languageResult = LanguageChange.applied
    var vibrancyResult = true
    var accent: String? = "0a84ffff"
    var saveError: Error?
    var keepServices = true
    var logsError: Error?
    var backupSettings = BackupSettingsValue(backupDir: "/Users/me/Backups", backupOnQuit: true)
    var restorePathAllowList = RestorePathAllowList()
    var pickedDirectory: String? = "/Users/me/Backups"
    var pickedFile: String? = "/Users/me/b.visionbak.enc"
    var encrypted = true

    func rendererDidFail(_ failure: RendererFailure) { calls.append("fail:\(failure.kind):\(failure.name)") }
    func rendererDidBecomeReady() { calls.append("ready") }
    func setDockBadge(_ count: Int) { calls.append("badge:\(count)") }
    func setLanguage(_ language: NativeLanguage) async -> LanguageChange {
        calls.append("language:\(language.rawValue)")
        return languageResult
    }
    func setVibrancy(_ enabled: Bool) -> Bool {
        calls.append("vibrancy:\(enabled)")
        return vibrancyResult
    }
    func accentColor() -> String? { accent }
    func persistSplashTheme(_ theme: SplashTheme) async -> Bool {
        calls.append("splash:\(theme.background)")
        return true
    }
    func saveServicesSettings(keepServicesOnQuit: Bool) async throws {
        calls.append("saveServices:\(keepServicesOnQuit)")
        if let saveError { throw saveError }
    }
    func loadServicesSettings() async -> Bool { keepServices }
    func saveBackupSettings(_ settings: BackupSettingsValue) async throws {
        calls.append("saveBackup:\(settings.backupDir):\(settings.backupOnQuit)")
        if let saveError { throw saveError }
    }
    func loadBackupSettings() async -> BackupSettingsValue {
        calls.append("loadBackup")
        return backupSettings
    }
    func runBackup(destination: String, frontendStateJson: String?) async -> JSONValue {
        calls.append("runBackup:\(destination):\(frontendStateJson ?? "nil")")
        return .object(["success": .bool(true), "file": .string("\(destination)/b.visionbak"), "encrypted": .bool(false)])
    }
    func selectBackupDirectory() async -> String? {
        calls.append("selectDir")
        return pickedDirectory
    }
    func selectRestoreFile() async -> String? {
        calls.append("selectFile")
        guard let pickedFile else { return nil }
        return restorePathAllowList.add(pickedFile)
    }
    func isBackupEncrypted(_ path: String) async -> Bool {
        calls.append("isEncrypted:\(path)")
        return encrypted
    }
    func restoreBackup(_ path: String, passphrase: String?) async -> JSONValue {
        calls.append("restore:\(path):\(passphrase ?? "nil")")
        return .object(["success": .bool(true), "file": .string(path), "frontendState": .null])
    }
    func backupEncryptionStatus() async -> PassphraseStatus {
        PassphraseStatus(hasEnvPassphrase: false, hasStoredPassphrase: true, secureStorageAvailable: true)
    }
    func setBackupPassphrase(_ passphrase: String) async -> PassphraseUpdateResult {
        calls.append("setPassphrase:\(passphrase)")
        return PassphraseUpdateResult(success: true, available: true)
    }
    func enrollAudit() async -> JSONValue {
        calls.append("auditEnroll")
        return .object(["success": .bool(true), "enrollmentSequence": .int(4)])
    }
    func readAudit(_ range: AuditViewer.ReadRange) async -> JSONValue {
        calls.append("auditRead:\(range.afterSequence):\(range.limit)")
        return .object(["success": .bool(false), "status": .string("unavailable")])
    }
    func exportAuditSnapshot() async -> JSONValue {
        calls.append("auditExport")
        return .object(["success": .bool(false), "cancelled": .bool(true)])
    }
    func exportAuditTransfer(password: String) async -> JSONValue {
        calls.append("auditTransferExport:\(password.count)")
        return .object(["success": .bool(true)])
    }
    func importAuditTransfer(password: String) async -> JSONValue {
        calls.append("auditTransferImport:\(password.count)")
        return .object(["success": .bool(true)])
    }
    func rotateAuditKey() async -> JSONValue {
        calls.append("auditRotate")
        return .object(["success": .bool(true), "sequence": .int(9)])
    }
    func retryLaunch() { calls.append("retry") }
    func openLogs() throws -> String {
        if let logsError { throw logsError }
        return "/logs"
    }
    func startWindowDrag() { calls.append("drag") }
    func titlebarDoubleClicked() { calls.append("double-click") }
    func routeDidChange(_ route: NativeRoute) { calls.append("route:\(route.string)") }
}

@MainActor
@Suite struct BridgeDispatcherTests {
    let app = URL(string: "http://localhost:41000")!
    var trusted: BridgeSender {
        BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "localhost", port: 41000))
    }

    private func reply(_ body: String, host: RecordingBridgeHost, sender: BridgeSender? = nil) async -> BridgeReply {
        await BridgeDispatcher.reply(to: body, sender: sender ?? trusted, appURL: app, host: host)
    }

    @Test func onlyTheAppMainFrameIsTrusted() async {
        let host = RecordingBridgeHost()
        let body = #"{"channel":"app:set-badge","args":[2]}"#
        for sender in [
            BridgeSender(isMainFrame: false, origin: BridgeOrigin(scheme: "http", host: "localhost", port: 41000)),
            BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "localhost", port: 3002)),
            BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "https", host: "localhost", port: 41000)),
            BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "127.0.0.1", port: 41000)),
            // An opaque origin (sandboxed or data: document) has an empty protocol and host.
            BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "", host: "", port: 0)),
            BridgeSender(isMainFrame: true, origin: nil),
        ] {
            #expect(await reply(body, host: host, sender: sender) == .reject(BridgeDispatcher.unauthorizedSenderMessage))
        }
        #expect(await BridgeDispatcher.reply(to: body, sender: trusted, appURL: nil, host: host) == .reject("Unauthorized sender"))
        #expect(host.calls.isEmpty)
    }

    @Test func theSenderIsJudgedByItsSecurityOrigin() {
        let app = URL(string: "http://localhost:41000")!
        #expect(BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "HTTP", host: "LocalHost", port: 41000)).isTrusted(appURL: app))
        // Port 0 is the protocol's default port.
        let defaultPort = URL(string: "http://localhost")!
        #expect(BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "localhost", port: 0)).isTrusted(appURL: defaultPort))
        #expect(!BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "localhost", port: 0)).isTrusted(appURL: app))
        let ipv6 = URL(string: "http://[::1]:41000")!
        #expect(BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "::1", port: 41000)).isTrusted(appURL: ipv6))
        #expect(BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "[::1]", port: 41000)).isTrusted(appURL: ipv6))
        #expect(!BridgeSender(isMainFrame: true, origin: BridgeOrigin(scheme: "http", host: "::1", port: 41000)).isTrusted(appURL: app))
    }

    @Test func implementedChannelsReachTheHost() async {
        let host = RecordingBridgeHost()
        #expect(await reply(#"{"channel":"app:renderer-ready","args":[]}"#, host: host) == .success)
        #expect(await reply(#"{"channel":"app:set-badge","args":[1200]}"#, host: host) == .success)
        #expect(await reply(#"{"channel":"app:set-vibrancy","args":[true]}"#, host: host) == .success)
        #expect(await reply(#"{"channel":"app:get-accent-color","args":[]}"#, host: host) == .resolve(.string("0a84ffff")))
        #expect(await reply(#"{"channel":"recovery:retry","args":[]}"#, host: host) == .success)
        #expect(
            await reply(#"{"channel":"recovery:open-logs","args":[]}"#, host: host)
                == .resolve(.object(["success": .bool(true), "path": .string("/logs")])))
        #expect(await reply(#"{"channel":"native:window-drag","args":[]}"#, host: host) == .success)
        #expect(host.calls == ["ready", "badge:999", "vibrancy:true", "retry", "drag"])
    }

    @Test func routeChangesReachTheHostOnlyWhenValid() async {
        let host = RecordingBridgeHost()
        let changed = #"{"channel":"shell:route-changed","args":["/admin/exchange-rates?tab=fallback"]}"#
        #expect(await reply(changed, host: host) == .success)
        for invalid in [
            #"{"channel":"shell:route-changed","args":["https://example.com/"]}"#,
            #"{"channel":"shell:route-changed","args":["//example.com/x"]}"#,
            #"{"channel":"shell:route-changed","args":[42]}"#,
            #"{"channel":"shell:route-changed","args":["/a","/b"]}"#,
            #"{"channel":"shell:route-changed","args":[]}"#,
        ] {
            #expect(await reply(invalid, host: host) == .failure, "\(invalid)")
        }
        #expect(host.calls == ["route:/admin/exchange-rates?tab=fallback"])
    }

    @Test func languageReportsASupersededRequest() async {
        let host = RecordingBridgeHost()
        host.languageResult = .superseded
        #expect(
            await reply(#"{"channel":"app:set-language","args":["nl"]}"#, host: host)
                == .resolve(.object(["success": .bool(true), "superseded": .bool(true)])))
        #expect(host.calls == ["language:nl"])
    }

    @Test func servicesSettingsRoundTrip() async {
        let host = RecordingBridgeHost()
        #expect(
            await reply(#"{"channel":"services:load-settings","args":[]}"#, host: host)
                == .resolve(.object(["keepServicesOnQuit": .bool(true)])))
        #expect(
            await reply(#"{"channel":"services:save-settings","args":[{"keepServicesOnQuit":false}]}"#, host: host)
                == .success)
        host.saveError = SettingsWriteError("Settings were not loaded. Reopen Vision before saving.")
        #expect(
            await reply(#"{"channel":"services:save-settings","args":[{"keepServicesOnQuit":true}]}"#, host: host)
                == .failed("Settings were not loaded. Reopen Vision before saving."))
    }

    @Test func removedChannelsRejectWithoutReachingTheHost() async {
        let host = RecordingBridgeHost()
        let updater = await reply(#"{"channel":"update:pre-update-backup","args":[]}"#, host: host)
        #expect(updater == .reject(BridgeContract.unavailableMessage(BridgeContract.entry(for: .updatePreUpdateBackup))))
        #expect(host.calls.isEmpty)
    }

    @Test func auditChannelsReachTheHost() async {
        let host = RecordingBridgeHost()
        let password = String(repeating: "p", count: 16)
        #expect(
            await reply(#"{"channel":"audit:enroll","args":[]}"#, host: host)
                == .resolve(.object(["success": .bool(true), "enrollmentSequence": .int(4)])))
        #expect(
            await reply(#"{"channel":"audit:read","args":[{"afterSequence":3,"limit":50}]}"#, host: host)
                == .resolve(.object(["success": .bool(false), "status": .string("unavailable")])))
        _ = await reply(#"{"channel":"audit:read","args":[null]}"#, host: host)
        _ = await reply(#"{"channel":"audit:export","args":[]}"#, host: host)
        _ = await reply(#"{"channel":"audit:transfer-export","args":[""# + password + #""]}"#, host: host)
        _ = await reply(#"{"channel":"audit:transfer-import","args":[""# + password + #""]}"#, host: host)
        #expect(
            await reply(#"{"channel":"audit:rotate-key","args":[]}"#, host: host)
                == .resolve(.object(["success": .bool(true), "sequence": .int(9)])))
        #expect(
            host.calls == [
                "auditEnroll", "auditRead:3:50", "auditRead:0:100", "auditExport", "auditTransferExport:16",
                "auditTransferImport:16", "auditRotate",
            ])
    }

    @Test func invalidAuditArgumentsAnswerTheChannelShape() async {
        let host = RecordingBridgeHost()
        #expect(
            await reply(#"{"channel":"audit:transfer-export","args":["short"]}"#, host: host)
                == .resolve(.object([
                    "success": .bool(false), "status": .string("failed"),
                    "reason": .string("transfer_password_invalid"),
                ])))
        #expect(
            await reply(#"{"channel":"audit:read","args":[{"limit":501}]}"#, host: host)
                == .resolve(.object([
                    "success": .bool(false), "status": .string("failed"),
                    "error": .string("Invalid audit read range"),
                ])))
        #expect(
            await reply(#"{"channel":"audit:rotate-key","args":[1]}"#, host: host)
                == .failed("Unexpected IPC arguments"))
        #expect(host.calls.isEmpty)
    }

    @Test func aLargeBackupRunReachesTheHost() async {
        let host = RecordingBridgeHost()
        let snapshot = String(repeating: "x", count: 100 * 1024)
        let body = #"{"channel":"backup:run","args":["/Users/me/Backups",""# + snapshot + #""]}"#
        let result = await reply(body, host: host)
        #expect(
            result
                == .resolve(.object([
                    "success": .bool(true), "file": .string("/Users/me/Backups/b.visionbak"), "encrypted": .bool(false),
                ])))
        #expect(host.calls == ["runBackup:/Users/me/Backups:\(snapshot)"])
    }

    @Test func restoreNeedsAPathFromThePicker() async {
        let host = RecordingBridgeHost()
        let restoreBody = #"{"channel":"backup:restore","args":["/Users/me/b.visionbak.enc",{"passphrase":"p"}]}"#
        let encryptedBody = #"{"channel":"backup:is-encrypted","args":["/Users/me/b.visionbak.enc"]}"#
        #expect(
            await reply(restoreBody, host: host)
                == .failed("Restore path was not selected via the file picker"))
        #expect(await reply(encryptedBody, host: host) == .resolve(.bool(false)))
        #expect(host.calls.isEmpty)

        #expect(
            await reply(#"{"channel":"backup:select-file","args":[]}"#, host: host)
                == .resolve(.string("/Users/me/b.visionbak.enc")))
        #expect(await reply(encryptedBody, host: host) == .resolve(.bool(true)))
        #expect(
            await reply(restoreBody, host: host)
                == .resolve(.object([
                    "success": .bool(true), "file": .string("/Users/me/b.visionbak.enc"), "frontendState": .null,
                ])))
        #expect(
            host.calls == [
                "selectFile", "isEncrypted:/Users/me/b.visionbak.enc", "restore:/Users/me/b.visionbak.enc:p",
            ])
        host.pickedFile = nil
        #expect(await reply(#"{"channel":"backup:select-file","args":[]}"#, host: host) == .resolve(.null))
    }

    @Test func passphraseChannelsAnswerFromTheHost() async {
        let host = RecordingBridgeHost()
        #expect(
            await reply(#"{"channel":"backup:get-encryption-status","args":[]}"#, host: host)
                == .resolve(.object([
                    "success": .bool(true), "hasEnvPassphrase": .bool(false), "hasStoredPassphrase": .bool(true),
                    "secureStorageAvailable": .bool(true),
                ])))
        #expect(
            await reply(#"{"channel":"backup:set-passphrase","args":[" secret "]}"#, host: host)
                == .resolve(.object(["success": .bool(true), "available": .bool(true)])))
        #expect(
            await reply(#"{"channel":"backup:select-dir","args":[]}"#, host: host)
                == .resolve(.string("/Users/me/Backups")))
        #expect(host.calls == ["setPassphrase: secret ", "selectDir"])
    }

    @Test func backupSettingsAnswerFromTheHost() async {
        let host = RecordingBridgeHost()
        #expect(
            await reply(#"{"channel":"backup:load-settings","args":[]}"#, host: host)
                == .resolve(.object(["backupDir": .string("/Users/me/Backups"), "backupOnQuit": .bool(true)])))
        #expect(
            await reply(#"{"channel":"backup:save-settings","args":[{"backupDir":"/Volumes/B","backupOnQuit":false}]}"#, host: host)
                == .success)
        #expect(
            await reply(#"{"channel":"backup:save-settings","args":[{"backupDir":"/usr/x","backupOnQuit":false}]}"#, host: host)
                == .failed("Backup to system directories is not allowed"))
        host.saveError = SettingsWriteError("Setting changed since it was loaded")
        #expect(
            await reply(#"{"channel":"backup:save-settings","args":[{"backupDir":"","backupOnQuit":false}]}"#, host: host)
                == .failed("Setting changed since it was loaded"))
        #expect(host.calls == ["loadBackup", "saveBackup:/Volumes/B:false", "saveBackup::false"])
    }

    @Test func aMissingBadgeCountKeepsTheBadge() async {
        let host = RecordingBridgeHost()
        #expect(await reply(#"{"channel":"app:set-badge","args":[]}"#, host: host) == .failure)
        #expect(await reply(#"{"channel":"app:set-badge","args":[null]}"#, host: host) == .failure)
        #expect(host.calls.isEmpty)
    }

    @Test func invalidCallsGetTheChannelsInvalidResult() async {
        let host = RecordingBridgeHost()
        #expect(await reply(#"{"channel":"app:set-language","args":["de"]}"#, host: host) == .failure)
        #expect(await reply(#"{"channel":"nope","args":[]}"#, host: host) == .reject(BridgeCodec.unknownChannelMessage))
        #expect(host.calls.isEmpty)
    }

    @Test func eventScriptCallsTheDispatcherWithJSON() {
        let script = BridgeDispatcher.eventScript(
            .menuAction, payload: BridgeDispatcher.menuActionPayload(.navigate("/import")))
        #expect(
            script
                == #"window.__visionNativeDispatch && window.__visionNativeDispatch("menu:action", {"action":"navigate","payload":"/import"});"#
        )
        #expect(
            BridgeDispatcher.menuActionPayload(.openSettings) == .object(["action": .string("open-settings")]))
    }
}

@Suite struct RendererMessageQueueTests {
    @Test func queuesUntilReadyAndResetsOnANewDocument() {
        var queue = RendererMessageQueue()
        #expect(queue.send(.menuAction, .string("a")).isEmpty)
        #expect(queue.send(.csvOpened, .string("b")).isEmpty)
        let flushed = queue.markReady()
        #expect(flushed.map(\.event) == [.menuAction, .csvOpened])
        #expect(queue.pending.isEmpty)
        #expect(queue.send(.menuAction, .string("c")).map(\.payload) == [.string("c")])
        queue.documentChanged()
        #expect(!queue.isReady)
        #expect(queue.send(.menuAction, .string("d")).isEmpty)
        #expect(queue.markReady().map(\.payload) == [.string("d")])
    }

    @Test func aLoadThatNeverCommitsKeepsReadiness() {
        // A navigation that becomes a download starts provisionally but never commits, so
        // the shell calls documentChanged() only on didCommit and events keep flowing.
        var queue = RendererMessageQueue()
        _ = queue.markReady()
        #expect(queue.send(.menuAction, .string("after-download")).map(\.payload) == [.string("after-download")])
        #expect(queue.pending.isEmpty)
    }
}
