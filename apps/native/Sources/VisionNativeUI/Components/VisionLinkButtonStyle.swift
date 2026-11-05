import SwiftUI
import VisionNativeCore

/// The web `variant="link"` button (button.tsx `text-primary underline-offset-4 hover:underline
/// decoration-primary/50`): `--primary` text with no chrome, underlined in `primary/0.5` on hover,
/// dimmed while pressed, `disabled:opacity-50`, with the focus ring. Replaces the system `.link`
/// style, which draws accent blue.
struct VisionLinkButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        LinkBody(configuration: configuration)
    }

    private struct LinkBody: View {
        let configuration: ButtonStyleConfiguration
        @Environment(\.visionTheme) private var theme
        @Environment(\.isEnabled) private var isEnabled
        @Environment(\.accessibilityReduceMotion) private var reduceMotion
        @State private var hovering = false

        var body: some View {
            let hover = hovering && isEnabled
            configuration.label
                .foregroundStyle(theme.primary)
                .underline(hover, color: theme.primary.opacity(0.5))
                .opacity(configuration.isPressed ? 0.7 : 1)
                .contentShape(Rectangle())
                .visionFocusRing(cornerRadius: CGFloat(DesignTokens.Radius.chip))
                .opacity(isEnabled ? 1 : VisionControlMetrics.disabledOpacity)
                .animation(VisionControlMetrics.fastTransition(reduceMotion: reduceMotion), value: hover)
                .onHover { hovering = $0 }
        }
    }
}

extension ButtonStyle where Self == VisionLinkButtonStyle {
    static var visionLink: VisionLinkButtonStyle { VisionLinkButtonStyle() }
}
