import AppKit
import CoreGraphics
import VisionNativeCore

/// Feeds `UserPresence` (main.ts `checkUserIdle` and the powerMonitor lock, unlock and resume
/// handlers): the input idle time every minute, the screen lock and unlock, and wake from sleep.
/// Runs for the shell's lifetime and ends when its task is cancelled.
@MainActor enum UserPresenceMonitor {
    static func run(presence: UserPresence = .shared) async {
        let distributed = DistributedNotificationCenter.default()
        let workspace = NSWorkspace.shared.notificationCenter
        var observers: [(NotificationCenter, NSObjectProtocol)] = []
        func observe(
            _ center: NotificationCenter, _ name: String, _ action: @escaping @MainActor @Sendable () -> Void
        ) {
            let token = center.addObserver(forName: Notification.Name(name), object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { action() }
            }
            observers.append((center, token))
        }
        observe(distributed, "com.apple.screenIsLocked") { presence.setScreenLocked(true, idleSeconds: Self.idleSeconds) }
        observe(distributed, "com.apple.screenIsUnlocked") {
            presence.setScreenLocked(false, idleSeconds: Self.idleSeconds)
        }
        observe(workspace, NSWorkspace.didWakeNotification.rawValue) { presence.update(idleSeconds: Self.idleSeconds) }
        defer { for (center, token) in observers { center.removeObserver(token) } }
        while !Task.isCancelled {
            presence.update(idleSeconds: Self.idleSeconds)
            do { try await Task.sleep(for: UserPresence.checkInterval) } catch { break }
        }
    }

    /// Seconds since the last keyboard or mouse event in the login session (`kCGAnyInputEventType`).
    private static var idleSeconds: TimeInterval {
        guard let any = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}
