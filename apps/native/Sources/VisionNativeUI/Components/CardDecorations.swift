import SwiftUI
import VisionNativeCore

/// TrendHue: a top-left to bottom-right wash of the trend colour at 10% → 5%.
struct TrendHue: View {
    enum Tone { case gain, loss, neutral }
    let tone: Tone
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let color: Color =
            switch tone {
            case .gain: theme.gain
            case .loss: theme.loss
            case .neutral: theme.primary
            }
        LinearGradient(colors: [color.opacity(0.10), color.opacity(0.05)], startPoint: .topLeading, endPoint: .bottomTrailing)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }
}

/// CardSheen: a circle centred on the card's top-right corner, filled with a gradient from
/// the highlight to transparent. `default` 8rem of `--glass-highlight` at 0.5 (0.12 dark),
/// `feature` 10rem, `hero` 12rem of `--background` at 0.4.
struct CardSheen: View {
    enum Tier { case `default`, feature, hero }
    let tier: Tier
    @Environment(\.visionTheme) private var theme

    var body: some View {
        let diameter: CGFloat = switch tier {
        case .default: 128
        case .feature: 160
        case .hero: 192
        }
        let start: Color =
            tier == .hero
            ? Color(token: theme.palette.background, opacity: 0.4)
            : Color(token: theme.palette.glassHighlight, opacity: theme.isDark ? 0.12 : 0.5)
        ZStack(alignment: .topTrailing) {
            Color.clear
            Circle()
                .fill(LinearGradient(colors: [start, .clear], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: diameter, height: diameter)
                .offset(x: diameter / 2, y: -diameter / 2)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// BackgroundQueryIndicator: while a read is in flight behind a shown screen, a 2 pt
/// primary/25 track with a primary → accent shimmer crossing it every 2.4 s (linear);
/// Reduce Motion keeps the static track.
struct BackgroundQueryIndicator: View {
    let inspector: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase: CGFloat = -1

    var body: some View {
        if inspector.inFlight.contains(where: { $0.method == .get }) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    theme.primary.opacity(0.25)
                    if !reduceMotion {
                        LinearGradient(
                            stops: [
                                .init(color: .clear, location: 0), .init(color: theme.primary, location: 0.45),
                                .init(color: theme.accent, location: 0.65), .init(color: .clear, location: 1),
                            ], startPoint: .leading, endPoint: .trailing
                        )
                        .frame(width: proxy.size.width)
                        .offset(x: phase * proxy.size.width)
                        .onAppear {
                            phase = -1
                            withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) { phase = 1 }
                        }
                    }
                }
                .clipped()
            }
            .frame(height: 2)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}
