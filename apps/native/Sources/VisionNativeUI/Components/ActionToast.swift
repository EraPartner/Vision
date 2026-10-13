import AppKit
import SwiftUI
import VisionNativeCore

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
    @Environment(\.visionTheme) var theme

    var body: some View {
        if let notice {
            let title = strings.t(notice.key, notice.variables)
            HStack(alignment: .center, spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Label(
                        title,
                        systemImage: notice.kind == .success ? "checkmark.circle.fill" : "exclamationmark.circle.fill")
                    if let detail = notice.detail, !detail.isEmpty {
                        Text(detail)
                            .font(.footnote)
                            .foregroundStyle(theme.secondaryLabel)
                            .lineLimit(3)
                    }
                }
                if let actionTitle {
                    Button(actionTitle, action: action)
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .background {
                            // The shortcut lives on its own invisible button so a click on Undo
                            // still acts while a field keeps focus; only the key checks typing.
                            Button("", action: undoShortcut)
                                .keyboardShortcut("z", modifiers: .command)
                                .opacity(0)
                                .frame(width: 0, height: 0)
                                .accessibilityHidden(true)
                        }
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: DesignTokens.Radius.card))
            .foregroundStyle(notice.kind == .success ? theme.foreground : theme.destructive)
            .frame(maxWidth: 560)
            .padding(.bottom, 20)
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

    /// ⌘Z: the field editor (an `NSTextView`) keeps its own undo while a text field has focus.
    private func undoShortcut() {
        if NSApp.keyWindow?.firstResponder is NSTextView {
            NSApp.sendAction(Selector(("undo:")), to: nil, from: nil)
            return
        }
        action()
    }
}
