import SwiftUI
import VisionNativeCore

/// The web `Input` (components/ui/input.tsx): `h-9 rounded-control border-input/70
/// bg-background/80 px-3`. Replaces the system rounded border, which reads grey and square
/// next to the web-style buttons. Focus is not tracked here: a second `.focused` binding
/// inside the style would compete with call sites that drive focus themselves.
struct VisionTextFieldStyle: TextFieldStyle {
    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    // swiftlint:disable:next identifier_name
    func _body(configuration: TextField<Self._Label>) -> some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
        configuration
            .textFieldStyle(.plain)
            .padding(.horizontal, 10)
            .frame(minHeight: 30)
            .background(shape.fill(Color(token: theme.palette.background, opacity: 0.8)))
            .overlay(
                shape.strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.5)
    }
}

extension TextFieldStyle where Self == VisionTextFieldStyle {
    static var vision: VisionTextFieldStyle { VisionTextFieldStyle() }
}

/// `DialogHeader` + `DialogTitle` + `DialogDescription` with the `DialogContent` close
/// button: a 20 pt display title, secondary body description, and a 16 pt xmark top right.
struct VisionDialogHeader: View {
    let title: String
    var description: String?
    let closeLabel: String
    var onClose: (() -> Void)?
    @Environment(\.visionTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text(title)
                    .font(.visionCardTitle)
                    .foregroundStyle(theme.foreground)
                    .fixedSize(horizontal: false, vertical: true)
                    .accessibilityAddTraits(.isHeader)
                if let description, !description.isEmpty {
                    Text(description)
                        .font(.body)
                        .foregroundStyle(theme.secondaryLabel)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 0)
            VisionDialogCloseButton(label: closeLabel) {
                if let onClose { onClose() } else { dismiss() }
            }
        }
    }
}

/// The `DialogContent` close control: `rounded-control p-1 text-label-secondary`, a faint
/// fill on hover.
struct VisionDialogCloseButton: View {
    let label: String
    let action: () -> Void
    @Environment(\.visionTheme) private var theme
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            Image(systemName: "xmark")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(hovering ? theme.foreground : theme.secondaryLabel)
                .frame(width: 24, height: 24)
                .background(
                    RoundedRectangle(cornerRadius: DesignTokens.Radius.chip, style: .continuous)
                        .fill(theme.foreground.opacity(hovering ? 0.06 : 0)))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(label)
        .accessibilityLabel(label)
    }
}

/// `DialogFooter`: the actions right-aligned with an 8 pt gap, the primary action last.
struct VisionDialogFooter<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            content
        }
        .controlSize(.large)
    }
}

/// `DialogContent` padding (`p-6`) and gap (`gap-5`) for a sheet body.
extension View {
    func visionDialogPadding() -> some View {
        padding(24)
    }
}
