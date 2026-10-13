import SwiftUI
import VisionNativeCore

/// One presentation surface for app-wide overlays; the route below keeps its visit alive.
struct NativeShellOverlayHost: View {
    let shell: NativeShellModel
    var body: some View {
        content
            .disabled(shell.nativeSettings?.isSuspendedForRestore == true)
            .interactiveDismissDisabled(preventsInteractiveDismissal)
            .environment(\.nativeNoticeCenter, shell.notices)
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
        if shell.nativeSettings?.isSuspendedForRestore == true { return true }
        switch shell.nativeOverlayKind {
        // Explicit Close/Escape writes completion first, retaining the wizard after a failed ACK.
        case .some(.onboarding): return true
        case .some(.report): return shell.reports?.isSubmitting == true
        default: return false
        }
    }
}
