import SwiftUI
import VisionNativeCore

/// Set by call sites that own a `@FocusState`, so a `.vision` text field (whose style cannot read
/// the focus of the field it wraps) draws the web focus state: `focus-visible:border-primary/60
/// focus-visible:bg-background/70` and the focus ring.
///
///     TextField("Name", text: $name).textFieldStyle(.vision).focused($focus, equals: .name)
///         .visionFieldFocused(focus == .name)
extension EnvironmentValues {
    @Entry var visionFieldFocused: Bool = false
}

extension View {
    /// Marks the `.vision` field(s) below as focused; see `EnvironmentValues.visionFieldFocused`.
    func visionFieldFocused(_ focused: Bool) -> some View { environment(\.visionFieldFocused, focused) }
}

/// The chrome shared by `Input`, `Textarea` and the `SelectTrigger` (components/ui/input.tsx,
/// textarea.tsx, select.tsx): `flex h-9 w-full rounded-control border border-input/70
/// bg-background/80 px-3 py-1.5 type-body shadow-[inset_0_1px_0_0_foreground/0.04] hover:border-input
/// focus-visible:border-primary/60 focus-visible:bg-background/70 focus-ring disabled:opacity-50`,
/// with the fast glide transition (none under Reduce Motion).
///
/// `isFocused` nil means focused when the call site set `visionFieldFocused` or the nearest focusable
/// ancestor (a `Button` wrapping the chrome) has focus.
struct VisionFieldChrome<Content: View>: View {
    var isFocused: Bool?
    var horizontalPadding: CGFloat = VisionControlMetrics.fieldHorizontalPadding
    var verticalPadding: CGFloat = 0
    var minHeight: CGFloat = VisionControlMetrics.fieldHeight
    var alignment: Alignment = .leading
    @ViewBuilder var content: Content

    var body: some View {
        content.modifier(
            VisionFieldChromeModifier(
                isFocused: isFocused, horizontalPadding: horizontalPadding, verticalPadding: verticalPadding,
                minHeight: minHeight, alignment: alignment))
    }
}

/// `VisionFieldChrome` as a modifier, for `TextFieldStyle._body`, which cannot hand its
/// configuration to a view-builder closure without sending it across isolation.
struct VisionFieldChromeModifier: ViewModifier {
    var isFocused: Bool?
    var horizontalPadding: CGFloat = VisionControlMetrics.fieldHorizontalPadding
    var verticalPadding: CGFloat = 0
    var minHeight: CGFloat = VisionControlMetrics.fieldHeight
    var alignment: Alignment = .leading

    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled
    @Environment(\.isFocused) private var environmentFocus
    @Environment(\.visionFieldFocused) private var fieldFocused
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hovering = false

    func body(content: Content) -> some View {
        let focused = isFocused ?? (fieldFocused || environmentFocus)
        let shape = RoundedRectangle(cornerRadius: VisionControlMetrics.radius, style: .continuous)
        content
            .padding(.horizontal, horizontalPadding)
            .padding(.vertical, verticalPadding)
            .frame(minHeight: minHeight, alignment: alignment)
            .background(shape.fill(Color(token: theme.palette.background, opacity: focused ? 0.7 : 0.8)))
            .overlay(insetHighlight(shape))
            .overlay(shape.strokeBorder(borderColor(focused: focused), lineWidth: VisionControlMetrics.borderWidth))
            .contentShape(shape)
            .visionFocusRing(focused, cornerRadius: VisionControlMetrics.radius)
            .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
            .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: focused)
            .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hovering)
            .onHover { hovering = $0 }
    }

    /// `hover:border-input`, `focus-visible:border-primary/60`, else `border-input/70`.
    private func borderColor(focused: Bool) -> Color {
        if focused { return theme.primary.opacity(0.6) }
        return Color(token: theme.palette.input, opacity: hovering && isEnabled ? 1 : 0.7)
    }

    /// `inset 0 1px 0 0 foreground/0.04`: a 1 pt edge on the top that fades out over the first
    /// eighth of the field, as `VisionGlassSurface` draws its inset highlight.
    private func insetHighlight(_ shape: RoundedRectangle) -> some View {
        shape.strokeBorder(
            LinearGradient(
                stops: [
                    Gradient.Stop(color: theme.foreground.opacity(0.04), location: 0),
                    Gradient.Stop(color: theme.foreground.opacity(0), location: 0.12),
                ],
                startPoint: .top, endPoint: .bottom),
            lineWidth: VisionControlMetrics.borderWidth
        )
        .allowsHitTesting(false)
    }
}

/// The web `Input` (components/ui/input.tsx): `h-9 rounded-control border-input/70
/// bg-background/80 px-3` with hover border, focus border and ring (see `VisionFieldChrome`).
/// Replaces the system rounded border, which reads grey and square next to the web-style
/// buttons. Focus is not tracked here: a second `.focused` binding inside the style would
/// compete with call sites that drive focus themselves, so they report it with
/// `.visionFieldFocused(_:)`. The placeholder colour (`placeholder:text-label-tertiary`) is set
/// per prompt with `Text.visionPlaceholder(theme:)`, since a style cannot reach it.
struct VisionTextFieldStyle: TextFieldStyle {
    // swiftlint:disable:next identifier_name
    func _body(configuration: TextField<Self._Label>) -> some View {
        configuration.textFieldStyle(.plain).modifier(VisionFieldChromeModifier())
    }
}

extension TextFieldStyle where Self == VisionTextFieldStyle {
    static var vision: VisionTextFieldStyle { VisionTextFieldStyle() }
}

extension Text {
    /// A text field prompt in `text-label-tertiary`:
    /// `TextField("Name", text: $name, prompt: Text("Name").visionPlaceholder(theme: theme))`.
    func visionPlaceholder(theme: VisionTheme) -> Text { foregroundStyle(theme.tertiaryLabel) }
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
    }
}

/// `DialogContent` padding (`p-6`) and gap (`gap-5`) for a sheet body.
extension View {
    func visionDialogPadding() -> some View {
        padding(24)
    }
}
