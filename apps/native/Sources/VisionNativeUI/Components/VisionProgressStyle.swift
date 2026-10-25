import SwiftUI
import VisionNativeCore

/// The web `Progress` (components/ui/progress.tsx): a rounded track in `foreground/[0.08]` with an
/// inset shadow and a `primary` fill that runs from `primary/80` to `primary`. `height` is the
/// `h-*` class (`h-2` by default, `h-1` in lists). The fill takes the value of the `ProgressView`,
/// so VoiceOver keeps reading it as a progress indicator.
struct VisionProgressViewStyle: ProgressViewStyle {
    /// `h-2`.
    static let defaultHeight: CGFloat = 8
    var height: CGFloat = defaultHeight

    func makeBody(configuration: Configuration) -> some View {
        VisionProgressBar(fraction: configuration.fractionCompleted ?? 0, height: height)
    }
}

private struct VisionProgressBar: View {
    let fraction: Double
    let height: CGFloat
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let clamped = CGFloat(min(max(fraction, 0), 1))
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Capsule().fill(theme.foreground.opacity(0.08))
                Capsule()
                    .fill(
                        LinearGradient(
                            colors: [theme.primary.opacity(0.8), theme.primary], startPoint: .leading,
                            endPoint: .trailing)
                    )
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: height)
    }
}

extension ProgressViewStyle where Self == VisionProgressViewStyle {
    /// `Progress` with the given `h-*` height in points.
    static func vision(height: CGFloat = VisionProgressViewStyle.defaultHeight) -> VisionProgressViewStyle {
        VisionProgressViewStyle(height: height)
    }
}
