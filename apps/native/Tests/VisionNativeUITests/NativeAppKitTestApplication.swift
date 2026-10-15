#if canImport(AppKit)
    import AppKit
    import CoreGraphics
    import Testing

    /// SwiftPM starts an async command-line runner, not an AppKit application.
    /// Initialize AppKit through its real launch/event-loop path before making hosts.
    /// This does not turn the remaining Swift Testing runner into an app-hosted runner.
    @MainActor enum NativeAppKitTestApplication {
        private static var prepared = false

        static func prepare() throws {
            guard !prepared else { return }
            let application = NSApplication.shared
            print("AppKit test context before launch: \(diagnostics())")
            try #require(Thread.isMainThread, "AppKit fixtures require the main thread")
            try #require(
                application.setActivationPolicy(.regular),
                "Cannot activate the synthetic test application: \(diagnostics())")

            if !application.isRunning {
                let stopper = LaunchTurnStopper()
                let timer = Timer(
                    timeInterval: 0.05, target: stopper,
                    selector: #selector(LaunchTurnStopper.stopApplication(_:)),
                    userInfo: nil, repeats: false)
                RunLoop.main.add(timer, forMode: .default)
                defer { timer.invalidate() }
                // A Timer target runs inside AppKit's event loop without waiting
                // for a nested MainActor task to execute on the same executor.
                application.run()
                try #require(
                    stopper.observedRunning,
                    "AppKit did not enter its application event loop: \(diagnostics())")
            }
            try #require(
                NSRunningApplication.current.isFinishedLaunching,
                "AppKit did not finish launching: \(diagnostics())")
            prepared = true
            application.activate()
            pumpEvents(until: Date().addingTimeInterval(0.05))
            print("AppKit test context after launch: \(diagnostics())")
        }

        static func pumpEvents(until deadline: Date) {
            let application = NSApplication.shared
            repeat {
                if let event = application.nextEvent(
                    matching: .any, until: deadline, inMode: .default, dequeue: true)
                {
                    application.sendEvent(event)
                }
                application.updateWindows()
            } while Date() < deadline
        }

        static func diagnostics(window: NSWindow? = nil) -> String {
            let application = NSApplication.shared
            let running = NSRunningApplication.current
            var values = [
                "mainThread=\(Thread.isMainThread)",
                "isRunning=\(application.isRunning)",
                "isActive=\(application.isActive)",
                "activationPolicy=\(application.activationPolicy().rawValue)",
                "finishedLaunching=\(running.isFinishedLaunching)",
                "runningActivationPolicy=\(running.activationPolicy.rawValue)",
                "screens=\(NSScreen.screens.count)",
                "windowServerSession=\(CGSessionCopyCurrentDictionary() != nil)",
                "keyWindowNumber=\(application.keyWindow?.windowNumber ?? -1)",
            ]
            if let window {
                values += [
                    "windowNumber=\(window.windowNumber)",
                    "windowVisible=\(window.isVisible)",
                    "windowOcclusion=\(window.occlusionState.rawValue)",
                    "windowIsKey=\(window.isKeyWindow)",
                    "windowCanBecomeKey=\(window.canBecomeKey)",
                    "isActualKeyWindow=\(application.keyWindow === window)",
                ]
            }
            return values.joined(separator: ", ")
        }
    }

    @MainActor private final class LaunchTurnStopper: NSObject {
        private(set) var observedRunning = false

        @objc func stopApplication(_ timer: Timer) {
            let application = NSApplication.shared
            observedRunning = application.isRunning
            application.stop(nil)
            // stop() takes effect after the next event; explicitly wake run().
            if let event = NSEvent.otherEvent(
                with: .applicationDefined, location: .zero, modifierFlags: [],
                timestamp: 0, windowNumber: 0, context: nil, subtype: 0, data1: 0, data2: 0)
            {
                application.postEvent(event, atStart: true)
            }
        }
    }
#endif
