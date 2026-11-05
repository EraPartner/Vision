import AppKit
import SwiftUI
import VisionNativeCore

/// The surface of a toast. The web toast is `glass-thick` (components/ui/sonner.tsx
/// `group toast glass-thick`, index.css `.glass-thick`), drawn as `VisionGlassSurface(.thick)`.
/// The Reduced tier and Reduce Transparency keep the flat `--card` fill.
struct ToastSurface: View {
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionVisualEffects) private var effects
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if effects == .reduced || reduceTransparency {
            RoundedRectangle(cornerRadius: DesignTokens.Radius.card).fill(theme.card)
        } else {
            // sonner.tsx draws every toast as `glass-thick`, with or without Full effects.
            VisionGlassSurface(material: .thick, cornerRadius: DesignTokens.Radius.card)
        }
    }
}

/// A Sonner toast with an optional action button, such as `undoToast`'s Undo: the title, the
/// description line and the action, for `duration`. The action also answers ⌘Z while the
/// toast is up, like the web's undo registry, except while a text field is being edited
/// (the web's `isTypingTarget` rule): there ⌘Z stays the field's own undo.
struct ActionToast: View {
    let notice: ScreenNotice?
    let strings: any Localizing
    /// The action's label, or `nil` for a plain toast.
    let actionTitle: String?
    let duration: Duration
    let action: () -> Void
    let clear: (Int) -> Void
    /// ⌘Z runs the action (an Undo); off for an action that is not one.
    var bindsUndoShortcut = true
    /// Lifts a stacked toast above the newer ones.
    var bottomPadding: CGFloat = 20
    @Environment(\.visionTheme) var theme
    @Environment(\.nativeNoticeCenter) private var globalNotices

    var body: some View {
        if let notice, globalNotices?.contains(notice) != true {
            let title = strings.t(notice.key, notice.variables)
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(title, systemImage: Self.symbol(notice.kind))
                    if let detail = notice.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .lineLimit(3)
                    }
                }
                if let actionTitle {
                    Button(actionTitle, action: action)
                        .buttonStyle(.visionOutline)
                        .controlSize(.small)
                        .background {
                            // The shortcut lives on its own invisible button so a click on Undo
                            // still acts while a field keeps focus; only the key checks typing.
                            if bindsUndoShortcut {
                                Button("", action: undoShortcut)
                                    .keyboardShortcut("z", modifiers: .command)
                                    .opacity(0)
                                    .frame(width: 0, height: 0)
                                    .accessibilityHidden(true)
                            }
                        }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background { ToastSurface() }
            .foregroundStyle(notice.kind == .error ? theme.destructive : theme.foreground)
            .frame(maxWidth: 560)
            .padding(.bottom, bottomPadding)
            .transition(.move(edge: .bottom).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .task(id: notice.id) {
                AccessibilityNotification.Announcement(title).post()
                try? await Task.sleep(for: duration)
                guard !Task.isCancelled else { return }
                clear(notice.id)
            }
        }
    }

    /// The toast's icon: success, error or `toast.info`.
    static func symbol(_ kind: ScreenNotice.Kind) -> String {
        switch kind {
        case .success: return "checkmark.circle.fill"
        case .error: return "exclamationmark.circle.fill"
        case .info: return "info.circle.fill"
        case .warning: return "exclamationmark.triangle.fill"
        }
    }

    /// ⌘Z: the field editor (an `NSTextView`) keeps its own undo while a text field has focus.
    private func undoShortcut() {
        if NSApp.keyWindow?.firstResponder is NSTextView {
            NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
            return
        }
        action()
    }
}
