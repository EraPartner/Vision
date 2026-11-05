import AppKit
import SwiftUI
import VisionNativeCore

/// Reports whether the hosting window is "live": key, on screen (not occluded, not minimised)
/// and its app not hidden. The native `document.hidden || !document.hasFocus()` that the web
/// aurora and `fx-idle-atmosphere` pause on (VisualEffectsController.tsx, ShaderAurora.tsx).
struct WindowLivenessProbe: NSViewRepresentable {
    let onChange: @MainActor (Bool) -> Void

    func makeNSView(context: Context) -> WindowLivenessView {
        let view = WindowLivenessView()
        view.onChange = onChange
        return view
    }

    func updateNSView(_ view: WindowLivenessView, context: Context) {
        view.onChange = onChange
    }

    static func dismantleNSView(_ view: WindowLivenessView, coordinator: ()) {
        view.stopObserving()
    }
}

@MainActor final class WindowLivenessView: NSView {
    var onChange: @MainActor (Bool) -> Void = { _ in }
    private var observers: [NSObjectProtocol] = []
    private var lastReported: Bool?

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        stopObserving()
        guard let window else { return }
        let center = NotificationCenter.default
        let windowNames: [Notification.Name] = [
            NSWindow.didBecomeKeyNotification, NSWindow.didResignKeyNotification,
            NSWindow.didChangeOcclusionStateNotification, NSWindow.didMiniaturizeNotification,
            NSWindow.didDeminiaturizeNotification,
        ]
        for name in windowNames { observe(name, object: window, center: center) }
        let appNames: [Notification.Name] = [
            NSApplication.didHideNotification, NSApplication.didUnhideNotification,
            NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
        ]
        for name in appNames { observe(name, object: NSApp, center: center) }
        report()
    }

    func stopObserving() {
        for observer in observers { NotificationCenter.default.removeObserver(observer) }
        observers = []
        lastReported = nil
    }

    private func observe(_ name: Notification.Name, object: AnyObject?, center: NotificationCenter) {
        observers.append(
            center.addObserver(forName: name, object: object, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.report() }
            })
    }

    private func report() {
        guard let window else { return }
        let live = AuroraPlayback.windowIsLive(
            isKey: window.isKeyWindow, isOnScreen: window.occlusionState.contains(.visible),
            isMiniaturized: window.isMiniaturized, appIsHidden: NSApp.isHidden)
        guard live != lastReported else { return }
        lastReported = live
        // Deferred: the first report arrives while SwiftUI is still applying a view update.
        Task { @MainActor [weak self] in self?.onChange(live) }
    }
}
