import AppKit
import OSLog
import SwiftUI
import VisionNativeCore

/// Process-wide runtime objects.
enum AppRuntime {
    /// Debug builds honour the developer overrides (`VISION_NATIVE_BACKEND_URL` and
    /// `VISION_NATIVE_RUNTIME_DIR`); Release builds ignore them.
    #if DEBUG
        static let isDebugBuild = true
    #else
        static let isDebugBuild = false
    #endif
    /// Starts and stops Vision Native's own PostgreSQL 18 cluster and backend.
    static let supervisor = RuntimeSupervisor.live(allowPayloadOverride: AppRuntime.isDebugBuild)
    static let logger = Logger(subsystem: "com.vaultvoyager.vision-native", category: "runtime")
    /// The `will-quit` hard timeout in `packaging/electron/main.ts`.
    static let shutdownTimeout: Duration = .seconds(45)
}

/// Stops the supervised runtime before the app terminates.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var shutdownFinished = false
    private var shutdownStarted = false

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shutdownFinished { return .terminateNow }
        if shutdownStarted { return .terminateLater }
        shutdownStarted = true
        Task.detached {
            await AppRuntime.supervisor.shutdown()
            await MainActor.run { self.finishShutdown(sender) }
        }
        Task {
            try? await Task.sleep(for: AppRuntime.shutdownTimeout)
            AppRuntime.logger.warning("Shutdown hard timeout reached; quitting without waiting for services.")
            self.finishShutdown(sender)
        }
        return .terminateLater
    }

    private func finishShutdown(_ sender: NSApplication) {
        guard !shutdownFinished else { return }
        shutdownFinished = true
        sender.reply(toApplicationShouldTerminate: true)
    }
}

@main
struct VisionNativeApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup("Vision Native") {
            ShellRootView()
        }
        .defaultSize(width: 1440, height: 900)
    }
}
