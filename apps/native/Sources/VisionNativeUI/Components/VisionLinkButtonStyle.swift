import SwiftUI
import VisionNativeCore

/// The web `variant="link"` button: emerald `--primary` text with no chrome, dimmed while
/// pressed. Replaces the system `.link` style, which draws accent blue.
struct VisionLinkButtonStyle: ButtonStyle {
    @Environment(\.visionTheme) private var theme
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundStyle(isEnabled ? theme.primary : theme.tertiaryLabel)
            .opacity(configuration.isPressed ? 0.7 : 1)
            .contentShape(Rectangle())
    }
}

extension ButtonStyle where Self == VisionLinkButtonStyle {
    static var visionLink: VisionLinkButtonStyle { VisionLinkButtonStyle() }
}
