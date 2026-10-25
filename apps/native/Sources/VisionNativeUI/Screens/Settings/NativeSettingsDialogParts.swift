import SwiftUI
import VisionNativeCore

/// The web `useConfirmDialog` `AlertDialog`: `max-w-lg p-6 gap-5`, a `type-title-2` title,
/// a `type-body text-label-secondary` description, and a right-aligned footer with the
/// outline Cancel first and the (destructive) confirm action last. Like `AlertDialog`
/// it has no close X; Escape runs Cancel.
struct NativeSettingsConfirmSheet: View {
    let title: String
    let message: String
    var detail: String?
    let confirmLabel: String
    let cancelLabel: String
    var destructive = true
    let onConfirm: () -> Void
    let onCancel: () -> Void
    @Environment(\.visionTheme) private var theme

    var body: some View {
        VStack(alignment: .leading, spacing: DesignTokens.Overlay.dialogGap) {
            VStack(alignment: .leading, spacing: 8) {
                Text(title)
                    .font(.visionCardTitle)
                    .foregroundStyle(theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                Text(message)
                    .font(.body)
                    .foregroundStyle(theme.secondaryLabel)
                    .fixedSize(horizontal: false, vertical: true)
                if let detail, !detail.isEmpty {
                    Text(verbatim: detail)
                        .font(.system(.footnote, design: .monospaced))
                        .foregroundStyle(theme.secondaryLabel)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            VisionDialogFooter {
                Button(cancelLabel, action: onCancel)
                    .buttonStyle(.visionOutline)
                    .keyboardShortcut(.cancelAction)
                Button(confirmLabel, role: destructive ? .destructive : nil, action: onConfirm)
                    .buttonStyle(.visionPrimary)
                    .keyboardShortcut(.defaultAction)
            }
        }
        .visionDialogPadding()
        .frame(width: DesignTokens.Overlay.dialogMaxWidth, alignment: .leading)
        .background(theme.card)
    }
}

/// The web `variant="ghost"` button: no chrome at rest, a faint fill on hover.
struct NativeSettingsGhostButtonStyle: ButtonStyle {
    @Environment(\.visionTheme) private var theme
    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        GhostBody(
            configuration: configuration, theme: theme, small: controlSize == .small || controlSize == .mini
        )
        .opacity(isEnabled ? 1 : 0.5)
    }

    private struct GhostBody: View {
        let configuration: ButtonStyleConfiguration
        let theme: VisionTheme
        let small: Bool
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
            configuration.label
                .font(small ? .footnote.weight(.medium) : .callout.weight(.medium))
                .lineLimit(1)
                .foregroundStyle(configuration.role == .destructive ? theme.destructive : theme.foreground)
                .padding(.horizontal, small ? 10 : 14)
                .frame(minHeight: small ? 24 : 30)
                .background(shape.fill(theme.foreground.opacity(hovering || configuration.isPressed ? 0.06 : 0)))
                .contentShape(shape)
                .onHover { hovering = $0 }
        }
    }
}
