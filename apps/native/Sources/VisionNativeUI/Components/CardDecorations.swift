import AppKit
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

/// BackgroundQueryIndicator: while a read refreshes data already shown (an endpoint that has
/// answered before; cold loads keep the page's own loading surface), a 2 pt
/// primary/25 track with a primary → accent shimmer crossing it every 2.4 s (linear);
/// Reduce Motion keeps the static track, as does an open modal (`fx-modal-open .animate-shimmer`:
/// nothing re-renders under the frosted overlay).
struct BackgroundQueryIndicator: View {
    let inspector: NativeAPIInspectorModel
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var windowLive = true

    var body: some View {
        if inspector.isRefreshingShownData {
            ZStack(alignment: .leading) {
                theme.primary.opacity(0.25)
                if !reduceMotion && UserPresence.shared.permitsDecorativeMotion(
                    windowIsLive: windowLive, modalIsOpen: VisionModalRegistry.shared.isOpen)
                {
                    ShimmerSweep(primary: theme.primary, accent: theme.accent)
                }
            }
            .clipped()
            .frame(height: 2)
            .background { WindowLivenessProbe { windowLive = $0 } }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// The shimmer's sweep: a gradient as wide as the track crossing it from fully left to fully right
/// every 2.4 s, linear. Core Animation plays it in the render server, so a long read costs the main
/// thread nothing per frame (a SwiftUI `repeatForever` offset is stepped by the app).
private struct ShimmerSweep: NSViewRepresentable {
    let primary: Color
    let accent: Color

    func makeNSView(context: Context) -> ShimmerSweepView { ShimmerSweepView() }

    func updateNSView(_ view: ShimmerSweepView, context: Context) {
        view.apply(primary: NSColor(primary).cgColor, accent: NSColor(accent).cgColor)
    }
}

@MainActor final class ShimmerSweepView: NSView {
    private static let sweepKey = "shimmer-sweep"
    private let host = CALayer()
    private let sweep = CAGradientLayer()
    private var sweptWidth: CGFloat = -1

    override init(frame: NSRect) {
        super.init(frame: frame)
        sweep.startPoint = CGPoint(x: 0, y: 0.5)
        sweep.endPoint = CGPoint(x: 1, y: 0.5)
        sweep.locations = [0, 0.45, 0.65, 1]
        host.masksToBounds = true
        host.addSublayer(sweep)
        layer = host
        wantsLayer = true
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    /// The stops fade to the neighbouring colour at alpha 0, as the CSS `transparent` ends interpolate.
    func apply(primary: CGColor, accent: CGColor) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sweep.colors = [primary.copy(alpha: 0) ?? primary, primary, accent, accent.copy(alpha: 0) ?? accent]
        CATransaction.commit()
    }

    override func layout() {
        super.layout()
        let width = bounds.width
        guard width != sweptWidth else { return }
        sweptWidth = width
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        sweep.bounds = CGRect(x: 0, y: 0, width: width, height: bounds.height)
        sweep.position = CGPoint(x: -width / 2, y: bounds.height / 2)
        CATransaction.commit()
        sweep.removeAnimation(forKey: Self.sweepKey)
        guard width > 0 else { return }
        let animation = CABasicAnimation(keyPath: "position.x")
        animation.fromValue = -width / 2
        animation.toValue = width * 1.5
        animation.duration = 2.4
        animation.repeatCount = .infinity
        animation.timingFunction = CAMediaTimingFunction(name: .linear)
        animation.isRemovedOnCompletion = false
        sweep.add(animation, forKey: Self.sweepKey)
    }
}
