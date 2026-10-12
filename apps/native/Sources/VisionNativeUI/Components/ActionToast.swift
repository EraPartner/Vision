import SwiftUI
import VisionNativeCore

/// A Sonner toast with an optional action button, such as `undoToast`'s Undo: the title, the
/// description line and the action, for `duration`. The action also answers ⌘Z while the
/// toast is up, like the web's undo registry.
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
                        .keyboardShortcut("z", modifiers: .command)
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
}
