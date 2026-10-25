import AppKit
import SwiftUI
import VisionNativeCore

/// One presentation surface for app-wide overlays; the route below keeps its visit alive.
///
/// `ShellRootView` presents it as an in-window glass dialog (`visionDialog`, the web `Dialog`),
/// sized per overlay by `metrics(for:)`.
struct NativeShellOverlayHost: View {
    let shell: NativeShellModel
    /// The overlay shown last. While the dialog animates out the model has already cleared its
    /// flags, so this keeps the closing overlay's content in place until the exit ends.
    @State private var lastKind: NativeShellOverlayKind?

    init(shell: NativeShellModel) {
        self.shell = shell
        _lastKind = State(initialValue: shell.nativeOverlayKind)
    }

    /// The dialog geometry of an overlay. Settings is `DashboardSettingsDialog`'s `max-w-4xl`,
    /// `h-[82vh]`, `p-0 gap-0`; the others size and pad themselves.
    static func metrics(for kind: NativeShellOverlayKind?) -> VisionDialogMetrics {
        switch kind {
        case .some(.settings):
            return VisionDialogMetrics(
                maxWidth: NativeSettingsWindow.Layout.maxWidth,
                height: .fraction(NativeSettingsWindow.Layout.heightFraction), padding: 0, spacing: 0)
        case .some(.palette):
            // `CommandDialog`: the default `max-w-lg` panel with `p-0`, sized to its content.
            return VisionDialogMetrics(padding: 0, spacing: 0)
        default:
            return VisionDialogMetrics(maxWidth: nil, padding: 0, spacing: 0)
        }
    }

    /// The `DialogTitle` announced when the dialog opens (`sr-only` in the settings dialog).
    static func accessibilityTitle(for kind: NativeShellOverlayKind?, strings: any Localizing) -> String? {
        switch kind {
        case .some(.settings): return strings.t("settings.title")
        case .some(.shortcuts): return strings.t("shortcuts.title")
        default: return nil
        }
    }

    var body: some View {
        content
            .disabled(shell.isReloadingGraph || shell.nativeSettings?.isSuspendedForRestore == true)
            .visionInteractiveDismissDisabled(preventsInteractiveDismissal)
            .environment(\.nativeNoticeCenter, shell.notices)
            .background {
                NativeOverlayFocusBridge(
                    kind: shell.nativeOverlayKind, context: NativeOverlayFocusContext(shell: shell)
                )
                .frame(width: 0, height: 0)
            }
            .overlay(alignment: .bottom) {
                if needsNoticeHost {
                    NativeNoticeHost(center: shell.notices, strings: shell.strings)
                }
            }
            .onChange(of: shell.nativeOverlayKind) { _, kind in if let kind { lastKind = kind } }
    }
    /// The overlay whose content is on screen: the live one, or the closing one.
    private var displayedKind: NativeShellOverlayKind? { shell.nativeOverlayKind ?? lastKind }
    private var content: some View {
        ZStack {
            if let settings = shell.nativeSettings, let ai = shell.settingsAI,
                let backup = shell.settingsBackup, let about = shell.settingsAbout,
                shell.isPresentingNativeSettings || (shell.nativeOverlayKind == nil && lastKind == .settings)
            {
                retained(
                    NativeSettingsScreenView(shell: shell, model: settings, ai: ai, backup: backup, about: about),
                    as: .settings)
            }
            if let palette = shell.commandPalette,
                palette.isOpen || (shell.nativeOverlayKind == nil && lastKind == .palette)
            {
                retained(NativeCommandPaletteView(model: palette, shell: shell), as: .palette)
            }
            if shell.isPresentingShortcuts || (shell.nativeOverlayKind == nil && lastKind == .shortcuts) {
                retained(NativeShortcutsHelpView(shell: shell, onClose: shell.closeShortcuts), as: .shortcuts)
            }
            if let onboarding = shell.onboarding,
                onboarding.isPresented || (shell.nativeOverlayKind == nil && lastKind == .onboarding)
            {
                retained(NativeOnboardingView(model: onboarding, shell: shell), as: .onboarding)
            }
            if let reports = shell.reports,
                reports.isPresented || (shell.nativeOverlayKind == nil && lastKind == .report)
            {
                retained(NativeReportSheet(model: reports, strings: shell.strings), as: .report)
            }
        }
    }
    private func retained<Content: View>(_ content: Content, as kind: NativeShellOverlayKind) -> some View {
        let active = displayedKind == kind
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
        switch displayedKind {
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
    func isAvailable(in window: NSWindow) -> Bool {
        guard let view else { return false }
        return view.window === window && !view.isHiddenOrHasHiddenAncestor
            && view.acceptsFirstResponder && (view as? NSControl)?.isEnabled != false
    }
    func restore(in window: NSWindow) {
        guard isAvailable(in: window), let view, window.makeFirstResponder(view) else { return }
        guard let selection, let editor = window.firstResponder as? NSTextView,
            Self.capture(editor)?.view === view, let length = editor.textStorage?.length,
            selection.location <= length, selection.length <= length - selection.location
        else { return }
        editor.setSelectedRange(selection)
    }
}

struct NativeOverlayFocusBridge: NSViewRepresentable {
    let kind: NativeShellOverlayKind?
    let context: NativeOverlayFocusContext
    func makeCoordinator() -> Coordinator { .init(kind: kind, context: context) }
    func makeNSView(context: Context) -> NSView {
        let view = NSView()
        view.setAccessibilityElement(false)
        context.coordinator.attach(view)
        return view
    }
    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.update(kind, context: self.context)
    }
    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) { coordinator.stop() }
    @MainActor final class Coordinator {
        private weak var marker: NSView?
        private var kind: NativeShellOverlayKind?
        private var context: NativeOverlayFocusContext
        private var snapshots: [String: NativeOverlayFocusSnapshot] = [:]
        // lint:allow explicit-any opaque AppKit event monitor token
        private var monitor: Any?
        private var restoring: Task<Void, Never>?
        init(kind: NativeShellOverlayKind?, context: NativeOverlayFocusContext) {
            self.kind = kind
            self.context = context
        }
        func attach(_ view: NSView) {
            marker = view
            monitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .leftMouseDown]) {
                [weak self] event in
                MainActor.assumeIsolated {
                    if let self, !self.context.isBlocked, let window = self.marker?.window,
                        NSApp.keyWindow === window,
                        event.window == nil || event.window === window
                    {
                        self.capture(window)
                    }
                }
                return event
            }
        }
        private func capture(_ window: NSWindow) {
            guard let kind, let snapshot = NativeOverlayFocusSnapshot.capture(window.firstResponder)
            else { return }
            snapshots[kind.rawValue] = snapshot
        }
        @discardableResult
        func update(_ next: NativeShellOverlayKind?, context: NativeOverlayFocusContext) -> Task<Void, Never>? {
            if context != self.context || context.isBlocked {
                restoring?.cancel()
                snapshots.removeAll()
                self.context = context
                kind = next
                return nil
            }
            guard next != kind else { return nil }
            if let kind, snapshots[kind.rawValue] == nil, let window = marker?.window { capture(window) }
            kind = next
            restoring?.cancel()
            guard let next, let snapshot = snapshots[next.rawValue] else { return nil }
            restoring = Task { [weak self] in
                await Task.yield()
                guard let self, !Task.isCancelled, self.kind == next, self.context == context,
                    let window = self.marker?.window, NSApp.keyWindow === window
                else { return }
                window.contentView?.layoutSubtreeIfNeeded()
                snapshot.restore(in: window)
            }
            return restoring
        }
        func stop() {
            restoring?.cancel()
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
            snapshots.removeAll()
        }
    }
}
