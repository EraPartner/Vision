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
    func retryLaunch() { calls.append("retry") }
    func openLogs() throws -> String {
        if let logsError { throw logsError }
        return "/logs"
    }
    func startWindowDrag() { calls.append("drag") }
    func titlebarDoubleClicked() { calls.append("double-click") }
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

    @Test func stubsRejectWithoutReachingTheHost() async {
        let host = RecordingBridgeHost()
        for channel in [BridgeChannel.backupSelectFile, .backupRestore, .backupGetEncryptionStatus] {
            let backup = await reply(#"{"channel":""# + channel.rawValue + #"","args":[]}"#, host: host)
            #expect(backup == .reject(BridgeContract.unavailableMessage(BridgeContract.entry(for: channel))))
            guard case .reject(let message) = backup else { continue }
            #expect(message.contains("phase 1d"))
        }
        let audit = await reply(#"{"channel":"audit:read","args":[{"afterSequence":0,"limit":50}]}"#, host: host)
        guard case .reject(let message) = audit else {
            Issue.record("audit:read must reject")
            return
        }
        #expect(message.contains("phase 1e"))
        #expect(host.calls.isEmpty)
    }

    @Test func aLargeBackupRunReachesTheStub() async {
        let host = RecordingBridgeHost()
        let snapshot = String(repeating: "x", count: 100 * 1024)
        let body = #"{"channel":"backup:run","args":["/Users/me/Backups",""# + snapshot + #""]}"#
        #expect(
            await reply(body, host: host)
                == .reject("electronBackup.runBackup is not available in Vision Native yet (backup and restore arrive in phase 1d)."))
        #expect(host.calls.isEmpty)
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
