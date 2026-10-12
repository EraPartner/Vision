import Foundation

public enum LanguageChange: Equatable, Sendable {
    case applied
    /// A newer `setLanguage` call arrived while this one loaded its strings.
    case superseded
}

/// What the shell does for each implemented channel. The app's shell controller conforms;
/// tests use a recording fake.
@MainActor
public protocol BridgeHost: AnyObject {
    func rendererDidFail(_ failure: RendererFailure)
    func rendererDidBecomeReady()
    func setDockBadge(_ count: Int)
    func setLanguage(_ language: NativeLanguage) async -> LanguageChange
    /// `false` when there is no window to apply it to.
    func setVibrancy(_ enabled: Bool) -> Bool
    /// `RRGGBBAA` hex, or `nil`.
    func accentColor() -> String?
    func persistSplashTheme(_ theme: SplashTheme) async -> Bool
    func saveServicesSettings(keepServicesOnQuit: Bool) async throws
    func loadServicesSettings() async -> Bool
    func retryLaunch()
    /// Opens the log folder and returns its path.
    func openLogs() throws -> String
    func startWindowDrag()
    func titlebarDoubleClicked()
}

/// Who sent a message: Electron's `trustedSender` check accepts only the main frame of the
/// app origin.
public struct BridgeSender: Equatable, Sendable {
    public var isMainFrame: Bool
    public var url: URL?

    public init(isMainFrame: Bool, url: URL?) {
        self.isMainFrame = isMainFrame
        self.url = url
    }

    public func isTrusted(appURL: URL?) -> Bool {
        guard isMainFrame, let url, let appURL else { return false }
        return NavigationPolicy.isAppURL(url, appURL: appURL)
    }
}

/// `registerHandler`: sender check, then argument validation, then the handler.
@MainActor
public enum BridgeDispatcher {
    public static let unauthorizedSenderMessage = "Unauthorized sender"

    public static func reply(
        to body: String?, sender: BridgeSender, appURL: URL?, host: any BridgeHost
    ) async -> BridgeReply {
        guard sender.isTrusted(appURL: appURL) else { return .reject(unauthorizedSenderMessage) }
        switch BridgeCodec.decode(body) {
        case .invalid(let message):
            return .reject(message)
        case .request(let request):
            switch BridgeCodec.validate(request) {
            case .invalid(let reply):
                return reply
            case .call(let call):
                return await perform(call, host: host)
            }
        }
    }

    public static func perform(_ call: BridgeCall, host: any BridgeHost) async -> BridgeReply {
        switch call {
        case .rendererFailure(let failure):
            host.rendererDidFail(failure)
            return .success
        case .rendererReady:
            host.rendererDidBecomeReady()
            return .success
        case .setBadge(let count):
            host.setDockBadge(count)
            return .success
        case .setLanguage(let language):
            switch await host.setLanguage(language) {
            case .applied:
                return .success
            case .superseded:
                return .resolve(.object(["success": .bool(true), "superseded": .bool(true)]))
            }
        case .setVibrancy(let enabled):
            return host.setVibrancy(enabled) ? .success : .failure
        case .getAccentColor:
            return .resolve(host.accentColor().map(JSONValue.string) ?? .null)
        case .persistSplashTheme(let theme):
            return await host.persistSplashTheme(theme) ? .success : .failure
        case .saveServicesSettings(let keep):
            do {
                try await host.saveServicesSettings(keepServicesOnQuit: keep)
                return .success
            } catch {
                return .failed((error as? LocalizedError)?.errorDescription ?? String(describing: error))
            }
        case .loadServicesSettings:
            return .resolve(.object(["keepServicesOnQuit": .bool(await host.loadServicesSettings())]))
        case .recoveryRetry:
            host.retryLaunch()
            return .success
        case .recoveryOpenLogs:
            do {
                let path = try host.openLogs()
                return .resolve(.object(["success": .bool(true), "path": .string(path)]))
            } catch {
                return .failed((error as? LocalizedError)?.errorDescription ?? String(describing: error))
            }
        case .windowDrag:
            host.startWindowDrag()
            return .success
        case .windowTitlebarDoubleClick:
            host.titlebarDoubleClicked()
            return .success
        case .unavailable(let channel):
            return .reject(BridgeContract.unavailableMessage(BridgeContract.entry(for: channel)))
        }
    }

    /// The script that delivers an event to the page's subscribers (`webContents.send`).
    public static func eventScript(_ event: BridgeEvent, payload: JSONValue) -> String {
        let channel = (try? JSONValue.string(event.rawValue).compactJSONString()) ?? "null"
        let value = (try? payload.compactJSONString()) ?? "null"
        return "window.\(BridgeScript.dispatchName) && window.\(BridgeScript.dispatchName)(\(channel), \(value));"
    }

    /// The `menu:action` payload, `{ action, payload? }`.
    public static func menuActionPayload(_ action: MenuAction) -> JSONValue {
        var fields: [String: JSONValue] = ["action": .string(action.action)]
        if let payload = action.payload { fields["payload"] = .string(payload) }
        return .object(fields)
    }
}

/// `sendToApp`: renderer-bound events wait until the page has called `ready()`, so actions
/// fired before React mounts (a dock menu click, an opened CSV) are not lost. A new document
/// clears readiness; same-document navigations (pushState) do not.
public struct RendererMessageQueue: Sendable {
    public struct Message: Equatable, Sendable {
        public let event: BridgeEvent
        public let payload: JSONValue
    }

    public private(set) var isReady = false
    public private(set) var pending: [Message] = []

    public init() {}

    /// Returns the messages to deliver now: this one when the page is ready, else none.
    public mutating func send(_ event: BridgeEvent, _ payload: JSONValue) -> [Message] {
        let message = Message(event: event, payload: payload)
        guard isReady else {
            pending.append(message)
            return []
        }
        return [message]
    }

    /// `app:renderer-ready`: returns the queued messages in order.
    public mutating func markReady() -> [Message] {
        isReady = true
        let flushed = pending
        pending = []
        return flushed
    }

    /// A main-frame load of a new document.
    public mutating func documentChanged() {
        isReady = false
    }
}
