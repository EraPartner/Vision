import SwiftUI
import VisionNativeCore

/// Control heights and paddings of the web `buttonVariants` sizes (`h-9 px-4`, `sm`, `xs`),
/// read from the SwiftUI control size so `.controlSize(.small)` call sites keep working.
private struct VisionButtonMetrics {
    let height: CGFloat
    let padding: CGFloat
    let font: Font

    init(_ size: ControlSize) {
        switch size {
        case .mini: (height, padding, font) = (20, 8, .caption.weight(.medium))
        case .small: (height, padding, font) = (24, 10, .footnote.weight(.medium))
        case .large, .extraLarge: (height, padding, font) = (36, 18, .body.weight(.medium))
        default: (height, padding, font) = (30, 14, .callout.weight(.medium))
        }
    }
}

/// The web `variant="outline"` button: `border-input/70`, `bg-background/80`, a brighter
/// fill on hover. Destructive-role buttons take the destructive colour for their label.
struct VisionOutlineButtonStyle: ButtonStyle {
    @Environment(\.visionTheme) private var theme
    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        OutlineBody(configuration: configuration, metrics: VisionButtonMetrics(controlSize), theme: theme)
            .opacity(isEnabled ? 1 : 0.5)
    }

    private struct OutlineBody: View {
        let configuration: Configuration
        let metrics: VisionButtonMetrics
        let theme: VisionTheme
        @State private var hovering = false

        var body: some View {
            let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
            configuration.label
                .font(metrics.font)
                .lineLimit(1)
                .foregroundStyle(configuration.role == .destructive ? theme.destructive : theme.foreground)
                .padding(.horizontal, metrics.padding)
                .frame(minHeight: metrics.height)
                .background(
                    shape.fill(
                        Color(token: theme.palette.background, opacity: hovering || configuration.isPressed ? 1 : 0.8))
                )
                .overlay(shape.strokeBorder(Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1))
                .contentShape(shape)
                .scaleEffect(configuration.isPressed ? 0.98 : 1)
                .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
                .onHover { hovering = $0 }
        }
    }
}

/// The web default button: a filled `--primary` (or the environment tint, so `.tint(...)`
/// call sites keep their colour) with `--primary-foreground` text and `shadow-sm`. Unlike
/// `.borderedProminent` it stays coloured while the window is inactive, as the web does.
struct VisionPrimaryButtonStyle: ButtonStyle {
    @Environment(\.visionTheme) private var theme
    @Environment(\.controlSize) private var controlSize
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        let metrics = VisionButtonMetrics(controlSize)
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
        let destructive = configuration.role == .destructive
        configuration.label
            .font(metrics.font)
            .lineLimit(1)
            .foregroundStyle(destructive ? Color(token: theme.palette.destructiveForeground) : theme.primaryForeground)
            .padding(.horizontal, metrics.padding)
            .frame(minHeight: metrics.height)
            .background {
                if destructive {
                    shape.fill(theme.destructive)
                } else {
                    shape.fill(.tint)
                }
            }
            .overlay(shape.fill(Color.black.opacity(configuration.isPressed ? 0.08 : 0)))
            .shadow(color: .black.opacity(0.12), radius: 1, y: 1)
            .contentShape(shape)
            .opacity(isEnabled ? 1 : 0.5)
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

extension ButtonStyle where Self == VisionOutlineButtonStyle {
    static var visionOutline: VisionOutlineButtonStyle { VisionOutlineButtonStyle() }
}

extension ButtonStyle where Self == VisionPrimaryButtonStyle {
    static var visionPrimary: VisionPrimaryButtonStyle { VisionPrimaryButtonStyle() }
}

/// The web filter chip (`Button variant="outline" size="sm"` in `TransactionsToolbar`): the
/// outline chrome drawn on a label, for `Menu` and toggle labels that cannot take a
/// `ButtonStyle`. `active` adds the primary tint the web uses for a set filter.
struct VisionChipChrome: ViewModifier {
    var active = false
    @Environment(\.visionTheme) private var theme
    @State private var hovering = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: DesignTokens.Radius.control, style: .continuous)
        content
            .font(.callout.weight(.medium))
            .padding(.horizontal, 12)
            .frame(height: 30)
            .background(
                shape.fill(
                    active
                        ? AnyShapeStyle(theme.primary.opacity(0.12))
                        : AnyShapeStyle(Color(token: theme.palette.background, opacity: hovering ? 1 : 0.8)))
            )
            .overlay(
                shape.strokeBorder(
                    active ? theme.primary.opacity(0.45) : Color(token: theme.palette.input, opacity: 0.7), lineWidth: 1)
            )
            .contentShape(shape)
            .onHover { hovering = $0 }
    }
}

extension View {
    func visionChipChrome(active: Bool = false) -> some View { modifier(VisionChipChrome(active: active)) }
}
