import AppKit
import OSLog
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
    /// Vision Native or Vision Native Demo, from the `VisionNativeVariant` Info.plist key
    /// the `VISION_NATIVE_VARIANT` build setting writes.
    static let variant = NativeVariant.fromInfoPlist(
        Bundle.main.object(forInfoDictionaryKey: NativeVariant.infoPlistKey))
    /// Starts and stops Vision Native's own PostgreSQL 18 cluster and backend.
    static let supervisor = RuntimeSupervisor.live(
        allowPayloadOverride: AppRuntime.isDebugBuild, variant: AppRuntime.variant)
    static let logger = Logger(subsystem: "com.vaultvoyager.vision-native", category: "runtime")
    static let shellLogger = Logger(subsystem: "com.vaultvoyager.vision-native", category: "shell")
    /// The `will-quit` hard timeout in `packaging/electron/main.ts`.
    static let shutdownTimeout: Duration = .seconds(45)
}

/// An AppKit entry point rather than a SwiftUI `App`, so the menu bar, dock menu and window
/// chrome follow Electron's shell instead of SwiftUI's defaults. SwiftUI draws the launch
/// state inside the window.
@main
@MainActor
enum VisionNativeMain {
    static let delegate = AppDelegate()

    static func main() {
        let application = NSApplication.shared
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private let shell = ShellController()
    private var shutdownFinished = false
    private var shutdownStarted = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        shell.start()
    }

    /// Electron's `activate`: a dock click shows the hidden window again.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { shell.showWindow() }
        return true
    }

    func applicationDockMenu(_ sender: NSApplication) -> NSMenu? {
        shell.dockMenu()
    }

    /// The red close button hides the window; only Quit ends the app.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        false
    }

    func application(_ application: NSApplication, open urls: [URL]) {
        shell.openFiles(urls)
    }

    func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
        true
    }

    /// Asks first while a native screen has unsaved changes, then stops the supervised
    /// runtime before the app terminates.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if shutdownFinished { return .terminateNow }
        if shutdownStarted { return .terminateLater }
        guard shell.confirmQuitWithUnsavedChanges() else { return .terminateCancel }
        shutdownStarted = true
        Task {
            // The frame save writes settings.json through the supervisor and the quit-time
            // backup needs the running services, so both finish before the shutdown.
            await shell.prepareForQuit()
            await AppRuntime.supervisor.shutdown()
            self.finishShutdown(sender)
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
