import AppKit
import CoreGraphics
import VisionNativeCore

/// Feeds `UserPresence` (main.ts `checkUserIdle` and the powerMonitor lock, unlock and resume
/// handlers): input idle time, screen lock and unlock, wake, power and thermal state.
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
        @MainActor @Sendable func updatePower() {
            let info = ProcessInfo.processInfo
            presence.updatePower(
                lowPower: info.isLowPowerModeEnabled,
                thermalPressure: info.thermalState == .serious || info.thermalState == .critical)
        }
        observe(.default, Notification.Name.NSProcessInfoPowerStateDidChange.rawValue) { updatePower() }
        observe(.default, ProcessInfo.thermalStateDidChangeNotification.rawValue) { updatePower() }
        updatePower()
        // Local input resumes motion immediately without installing a global event monitor.
        let input = NSEvent.addLocalMonitorForEvents(
            matching: [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged,
                .rightMouseDragged, .otherMouseDown, .otherMouseDragged]
        ) { event in
            MainActor.assumeIsolated { presence.update(idleSeconds: 0) }
            return event
        }
        defer {
            for (center, token) in observers { center.removeObserver(token) }
            if let input { NSEvent.removeMonitor(input) }
        }
        while !Task.isCancelled {
            presence.update(idleSeconds: Self.idleSeconds)
            // One inexpensive input-clock read per second; publish only state transitions.
            do { try await Task.sleep(for: UserPresence.checkInterval) } catch { break }
        }
    }

    /// Seconds since the last keyboard or mouse event in the login session (`kCGAnyInputEventType`).
    private static var idleSeconds: TimeInterval {
        guard let any = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}
