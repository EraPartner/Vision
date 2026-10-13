import AppKit
import SwiftUI
import VisionNativeCore

/// One presentation surface for app-wide overlays; the route below keeps its visit alive.
struct NativeShellOverlayHost: View {
    let shell: NativeShellModel
    var body: some View {
        content
            .disabled(shell.isReloadingGraph || shell.nativeSettings?.isSuspendedForRestore == true)
            .interactiveDismissDisabled(preventsInteractiveDismissal)
            .environment(\.nativeNoticeCenter, shell.notices)
            .background { NativeOverlayFocusBridge(kind: shell.nativeOverlayKind).frame(width: 0, height: 0) }
            .overlay(alignment: .bottom) {
                if needsNoticeHost {
                    NativeNoticeHost(center: shell.notices, strings: shell.strings)
                }
            }
    }
    private var content: some View {
        ZStack {
            if shell.isPresentingNativeSettings,
                let settings = shell.nativeSettings, let ai = shell.settingsAI,
                let backup = shell.settingsBackup, let about = shell.settingsAbout
            {
                retained(
                    NativeSettingsScreenView(shell: shell, model: settings, ai: ai, backup: backup, about: about),
                    as: .settings)
            }
            if let palette = shell.commandPalette, palette.isOpen {
                retained(NativeCommandPaletteView(model: palette, shell: shell), as: .palette)
            }
            if shell.isPresentingShortcuts {
                retained(NativeShortcutsHelpView(shell: shell, onClose: shell.closeShortcuts), as: .shortcuts)
            }
            if let onboarding = shell.onboarding, onboarding.isPresented {
                retained(NativeOnboardingView(model: onboarding, shell: shell), as: .onboarding)
            }
            if let reports = shell.reports, reports.isPresented {
                retained(NativeReportSheet(model: reports, strings: shell.strings), as: .report)
            }
        }
    }
    private func retained<Content: View>(_ content: Content, as kind: NativeShellOverlayKind) -> some View {
        let active = shell.nativeOverlayKind == kind
        return
            content
            .frame(width: active ? nil : 0, height: active ? nil : 0)
            .opacity(active ? 1 : 0)
            .clipped()
            .allowsHitTesting(active)
            .disabled(!active)
            .accessibilityHidden(!active)
            .environment(\.nativeNoticeAnnouncementsEnabled, active)
    }
    private var needsNoticeHost: Bool {
        switch shell.nativeOverlayKind {
        case .some(.palette), .some(.shortcuts), .some(.report): return true
        default: return false
        }
    }
    private var preventsInteractiveDismissal: Bool {
        if shell.isReloadingGraph || shell.nativeSettings?.isSuspendedForRestore == true { return true }
        switch shell.nativeOverlayKind {
        // Explicit Close/Escape writes completion first, retaining the wizard after a failed ACK.
        case .some(.onboarding): return true
        case .some(.report): return shell.reports?.isSubmitting == true
        default: return false
        }
    }
}

/// A field editor is shared by a window: remember its owning control, never the editor itself.
@MainActor final class NativeOverlayFocusSnapshot {
    weak var view: NSView?
    let selection: NSRange?
    init(view: NSView, selection: NSRange? = nil) {
        self.view = view
        self.selection = selection
    }
    static func capture(_ responder: NSResponder?) -> NativeOverlayFocusSnapshot? {
        if let editor = responder as? NSTextView {
            if editor.isFieldEditor {
                let owner = (editor.delegate as? NSView) ?? (editor.delegate as? NSCell)?.controlView
                guard let owner else { return nil }
                return .init(view: owner, selection: editor.selectedRange())
            }
            return .init(view: editor, selection: editor.selectedRange())
        }
        guard let view = responder as? NSView else { return nil }
        return .init(view: view)
    }
    func restore(in window: NSWindow) {
        guard let view, view.window === window, !view.isHiddenOrHasHiddenAncestor,
            view.acceptsFirstResponder, (view as? NSControl)?.isEnabled != false,
            window.makeFirstResponder(view)
        else { return }
        guard let selection, let editor = window.firstResponder as? NSTextView,
            Self.capture(editor)?.view === view, let length = editor.textStorage?.length,
            selection.location <= length, selection.length <= length - selection.location
        else { return }
        editor.setSelectedRange(selection)
    }
}

private struct NativeOverlayFocusBridge: NSViewRepresentable {
    let kind: NativeShellOverlayKind?
    func makeCoordinator() -> Coordinator { .init(kind: kind) }
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.setAccessibilityElement(false)
        context.coordinator.attach(view)
        return view
    }
    func updateNSView(_ view: NSView, context: Context) { context.coordinator.update(kind) }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.stop() }
    @MainActor final class Coordinator {
        private weak var marker: NSView?
        private var kind: NativeShellOverlayKind?
        private var snapshots: [String: NativeOverlayFocusSnapshot] = [:]
        private var monitor: Any?
        private var restoring: Task<Void, Never>?
        init(kind: NativeShellOverlayKind?) { self.kind = kind }
        func attach(_ view: NSView) {
            marker = view
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) { [weak self] event in
                MainActor.assumeIsolated {
                    if let self, let window = self.marker?.window, NSApp.keyWindow === window,
                        event.window == nil || event.window === window
                    {
                        self.capture(window)
                    }
                }
                return event
            }
        }
        private func capture(_ window: NSWindow) {
            guard let kind, let snapshot = NativeOverlayFocusSnapshot.capture(window.firstResponder) else { return }
            snapshots[kind.rawValue] = snapshot
        }
        func update(_ next: NativeShellOverlayKind?) {
            guard next != kind else { return }
            if let kind, snapshots[kind.rawValue] == nil, let window = marker?.window { capture(window) }
            kind = next
            restoring?.cancel()
            guard let next, let snapshot = snapshots[next.rawValue] else { return }
            restoring = Task { [weak self] in
                await Task.yield()
                guard let self, !Task.isCancelled, self.kind == next,
                    let window = self.marker?.window, NSApp.keyWindow === window
                else { return }
                window.contentView?.layoutSubtreeIfNeeded()
                snapshot.restore(in: window)
            }
        }
        func stop() {
            restoring?.cancel()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            snapshots.removeAll()
        }
    }
}
