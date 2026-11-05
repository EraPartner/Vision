import Foundation
import UserNotifications
import os

/// Electron's `notify(body)`: a system notification titled with the app name. Permission is
/// asked once, on the first notice; when it is denied or unavailable (an unsigned build)
/// `post` answers `false` and the caller decides on a fallback.
@MainActor
final class SystemNotifier {
    private let appName: String
    private let logger: Logger
    private var authorization: Task<Bool, Never>?

    init(appName: String, logger: Logger) {
        self.appName = appName
        self.logger = logger
    }

    /// `askIfNeeded: false` posts only when permission was already granted, so a quit never
    /// waits on the permission prompt.
    @discardableResult
    func post(_ body: String, askIfNeeded: Bool = true) async -> Bool {
        let allowed: Bool
        if askIfNeeded {
            allowed = await isAuthorized()
        } else {
            allowed = await Self.authorizationStatus() == .authorized
        }
        guard allowed else { return false }
        let content = UNMutableNotificationContent()
        content.title = appName
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await UNUserNotificationCenter.current().add(request)
            return true
        } catch {
            logger.warning("[notify] not delivered: \(error.localizedDescription, privacy: .public)")
            return false
        }
    }

    private nonisolated static func authorizationStatus() async -> UNAuthorizationStatus {
        await UNUserNotificationCenter.current().notificationSettings().authorizationStatus
    }

    private func isAuthorized() async -> Bool {
        if let authorization { return await authorization.value }
        let logger = logger
        let task = Task { () -> Bool in
            do {
                return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound])
            } catch {
                logger.warning("[notify] unavailable: \(error.localizedDescription, privacy: .public)")
                return false
            }
        }
        authorization = task
        return await task.value
    }
}
