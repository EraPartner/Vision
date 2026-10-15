import AppKit
import SwiftUI
import VisionNativeCore

/// Settings/export query changes cover a visit; other route or graph changes retire its opener.
struct NativeOverlayFocusContext: Equatable {
    let graph: ObjectIdentifier
    let route: NativeRoute
    let isBlocked: Bool

    init(graph: ObjectIdentifier, route: NativeRoute, isBlocked: Bool = false) {
        self.graph = graph
        self.route = route.removing("settings").removing("export")
        self.isBlocked = isBlocked
    }

    @MainActor init(shell: NativeShellModel) {
        self.init(
            graph: ObjectIdentifier(shell), route: shell.route,
            isBlocked: shell.isReloadingGraph || shell.nativeSettings?.isSuspendedForRestore == true)
    }
}

/// Lives in the route window, before AppKit moves focus into the shared overlay sheet.
struct NativeOverlayFocusReturnBridge: NSViewRepresentable {
    let owner: NativeOverlayFocusReturnCoordinator
    let context: NativeOverlayFocusContext
    let isPresented: Bool

    func makeCoordinator() -> NativeOverlayFocusReturnCoordinator { owner }
    func makeNSView(context: Context) -> NSView {
        let marker = NSView()
        marker.setAccessibilityElement(false)
        context.coordinator.attach(marker)
        context.coordinator.update(self.context, isPresented: isPresented)
        return marker
    }
    func updateNSView(_ marker: NSView, context: Context) {
        context.coordinator.update(self.context, isPresented: isPresented)
    }
    static func dismantleNSView(_ marker: NSView, coordinator: NativeOverlayFocusReturnCoordinator) {
        coordinator.stop()
    }
}

@MainActor final class NativeOverlayFocusReturnCoordinator {
    private weak var marker: NSView?
    private weak var presentingWindow: NSWindow?
    private var context: NativeOverlayFocusContext?
    private var returnContext: NativeOverlayFocusContext?
    private var isPresented = false
    private var lastFocus: NativeOverlayFocusSnapshot?
    private var opener: NativeOverlayFocusSnapshot?
    private var monitor: Any?
    private var revision = 0
    private var restoration: Task<Void, Never>?

    func attach(_ marker: NSView) {
        self.marker = marker
        monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) {
            [weak self] event in
            MainActor.assumeIsolated {
                if let self, !self.isPresented, self.context?.isBlocked == false,
                    let window = self.marker?.window, NSApp.keyWindow === window,
                    event.window == nil || event.window === window
                {
                    self.lastFocus = NativeOverlayFocusSnapshot.capture(window.firstResponder)
                }
            }
            return event
        }
    }

    func update(_ next: NativeOverlayFocusContext, isPresented: Bool) {
        let changedContext = context != next
        if changedContext || self.isPresented != isPresented {
            revision += 1
            restoration?.cancel()
        }
        if changedContext || next.isBlocked {
            lastFocus = nil
            opener = nil
            returnContext = nil
            presentingWindow = nil
        }
        context = next
        if !self.isPresented, isPresented, !next.isBlocked, let window = marker?.window {
            let current = NativeOverlayFocusSnapshot.capture(window.firstResponder)
            opener = current?.isAvailable(in: window) == true ? current : lastFocus
            returnContext = next
            presentingWindow = window
        }
        self.isPresented = isPresented
    }

    /// AppKit has ended the sheet; a model's close request alone is too early to return focus.
    @discardableResult
    func didDismiss(context: NativeOverlayFocusContext, isPresented: Bool) -> Task<Void, Never>? {
        update(context, isPresented: isPresented)
        guard !isPresented, !context.isBlocked, returnContext == context,
            let opener, let window = presentingWindow
        else { return nil }
        self.opener = nil
        lastFocus = nil
        returnContext = nil
        presentingWindow = nil
        let revision = revision
        restoration = Task { [weak self, weak window] in
            await Task.yield()
            guard let self, let window, !Task.isCancelled, self.revision == revision,
                !self.isPresented, self.context == context, self.marker?.window === window,
                NSApp.keyWindow === window, window.attachedSheet == nil
            else { return }
            window.contentView?.layoutSubtreeIfNeeded()
            opener.restore(in: window)
        }
        return restoration
    }

    func stop() {
        revision += 1
        restoration?.cancel()
        restoration = nil
        if let monitor { NSEvent.removeMonitor(monitor) }
        monitor = nil
        marker = nil
        presentingWindow = nil
        opener = nil
        lastFocus = nil
        context = nil
        returnContext = nil
        isPresented = false
    }
}
