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
        observe(.default, Notification.Name.NSProcessInfoPowerStateDidChange.rawValue) {
            Self.updatePower(presence)
        }
        observe(.default, ProcessInfo.thermalStateDidChangeNotification.rawValue) { Self.updatePower(presence) }
        updatePower(presence)
        // Local input resumes motion immediately without installing a global event monitor.
        let input = NSEvent.addLocalMonitorForEvents(
            matching: [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged,
                .rightMouseDragged, .otherMouseDown, .otherMouseDragged]
        ) { event in
            MainActor.assumeIsolated { presence.noteLocalInput() }
            return event
        }
        defer {
            for (center, token) in observers { center.removeObserver(token) }
            if let input { NSEvent.removeMonitor(input) }
        }
        // No fixed fast poll: each wake re-arms for the decorative idle moment (at most every
        // 30 s while input continues) or the 60 s away poll.
        while !Task.isCancelled {
            let idle = Self.idleSeconds
            presence.update(idleSeconds: idle)
            do { try await Task.sleep(for: .seconds(presence.nextCheck(idleSeconds: idle))) } catch { break }
        }
    }

    /// Low Power Mode and the thermal state (list item 1.9).
    private static func updatePower(_ presence: UserPresence) {
        let info = ProcessInfo.processInfo
        presence.updatePower(
            lowPower: info.isLowPowerModeEnabled,
            thermalPressure: info.thermalState == .serious || info.thermalState == .critical,
            thermalFair: info.thermalState == .fair)
    }

    /// Seconds since the last keyboard or mouse event in the login session (`kCGAnyInputEventType`).
    private static var idleSeconds: TimeInterval {
        guard let any = CGEventType(rawValue: ~0) else { return 0 }
        return CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: any)
    }
}
