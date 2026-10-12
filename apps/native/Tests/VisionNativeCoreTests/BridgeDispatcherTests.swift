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
    var trusted: BridgeSender { BridgeSender(isMainFrame: true, url: URL(string: "http://localhost:41000/transactions")) }

    private func reply(_ body: String, host: RecordingBridgeHost, sender: BridgeSender? = nil) async -> BridgeReply {
        await BridgeDispatcher.reply(to: body, sender: sender ?? trusted, appURL: app, host: host)
    }

    @Test func onlyTheAppMainFrameIsTrusted() async {
        let host = RecordingBridgeHost()
        let body = #"{"channel":"app:set-badge","args":[2]}"#
        for sender in [
            BridgeSender(isMainFrame: false, url: URL(string: "http://localhost:41000/")),
            BridgeSender(isMainFrame: true, url: URL(string: "http://localhost:3002/")),
            BridgeSender(isMainFrame: true, url: nil),
        ] {
            #expect(await reply(body, host: host, sender: sender) == .reject(BridgeDispatcher.unauthorizedSenderMessage))
        }
        #expect(await BridgeDispatcher.reply(to: body, sender: trusted, appURL: nil, host: host) == .reject("Unauthorized sender"))
        #expect(host.calls.isEmpty)
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
        let backup = await reply(#"{"channel":"backup:load-settings","args":[]}"#, host: host)
        #expect(backup == .reject(BridgeContract.unavailableMessage(BridgeContract.entry(for: .backupLoadSettings))))
        let audit = await reply(#"{"channel":"audit:read","args":[{"afterSequence":0,"limit":50}]}"#, host: host)
        guard case .reject(let message) = audit else {
            Issue.record("audit:read must reject")
            return
        }
        #expect(message.contains("phase 1e"))
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
}
