import SwiftUI
import VisionNativeCore

/// The web `<Card>` surface (`card-material glass-thin premium-frame rounded-card`, index.css;
/// components/ui/card.tsx): a vertical glass-surface gradient, the `--border`/0.7 frame, the
/// embossed inset edge (a top highlight and, in light mode, a bottom hairline) and the soft
/// drop shadow. Print reports keep a flat white card with a hairline.
///
/// Full effects (`useFullEffects`, card.tsx) swap `glass-thin` for `glass-regular`: a system
/// material backdrop under the 135 degree regular gradient. The premium frame (border, edge,
/// shadow) stays, as `.premium-frame` overrides the material's own.
///
/// An interactive card (`premium-frame-interactive`, index.css) tints its frame with
/// `--primary` and raises the lift shadow while `hovering`; see `visionCardBackground(interactive:)`.
struct VisionCardBackground: View {
    var cornerRadius: CGFloat = DesignTokens.Radius.card
    /// A coloured frame (selection, warning) replacing the neutral `--border`/0.7.
    var stroke: Color?
    /// The pointer is over an interactive card.
    var hovering = false
    /// The card is interactive: it animates its hover frame and shadow.
    var interactive = false
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionFullEffects) private var fullEffects
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if theme.isPrintReport {
            shape.fill(theme.card).overlay(shape.strokeBorder(stroke ?? theme.border, lineWidth: 1))
        } else {
            let palette = theme.palette
            let lifted = interactive && hovering
            // `.premium-frame-interactive:hover` frame: `--primary` at 0.4, dark 0.5.
            let frame: Color =
                stroke
                ?? (lifted
                    ? theme.primary.opacity(DesignTokens.Hover.cardBorderAlpha.value(isDark: theme.isDark))
                    : theme.border.opacity(0.7))
            // `:root.fx-full .premium-frame-interactive:hover` raises the inset highlight to
            // 0.22 (dark 0.12); otherwise the resting 0.16 (dark 0.06).
            let highlightAlpha: Double =
                fullEffects && lifted ? (theme.isDark ? 0.12 : 0.22) : (theme.isDark ? 0.06 : 0.16)
            // `.premium-frame-interactive::after` / hover box-shadow, a fade in (index.css).
            let lift = DesignTokens.Hover.cardShadow.value(isDark: theme.isDark).first
            let liftAlpha = lifted ? (lift?.alpha ?? 0) : 0
            fill(shape)
                // premium-frame's inset edge: `0 1px 0 highlight inset` and, light only,
                // `0 -1px 0 shadow/0.05 inset`.
                .overlay(
                    shape.inset(by: 1).strokeBorder(
                        LinearGradient(
                            stops: [
                                .init(color: Color(token: palette.glassHighlight, opacity: highlightAlpha), location: 0),
                                .init(color: .clear, location: 0.12),
                                .init(color: .clear, location: 0.88),
                                .init(
                                    color: Color(token: palette.glassShadow, opacity: theme.isDark ? 0 : 0.05),
                                    location: 1),
                            ], startPoint: .top, endPoint: .bottom),
                        lineWidth: 1)
                )
                .overlay(shape.strokeBorder(frame, lineWidth: 1))
                // `0 4px 12px shadow/0.04` light, `0 5px 16px shadow/0.2` dark (CSS blur ≈ 2 × radius).
                .shadow(
                    color: Color(token: palette.glassShadow, opacity: theme.isDark ? 0.2 : 0.04),
                    radius: theme.isDark ? 8 : 6, y: theme.isDark ? 5 : 4)
                .shadow(
                    color: Color(token: palette.glassShadow, opacity: liftAlpha),
                    radius: interactive ? (lift?.blur ?? 0) / 2 : 0, x: lift?.x ?? 0, y: lift?.y ?? 0
                )
                .animation(hoverAnimation, value: hovering)
        }
    }

    /// `transition` of `.premium-frame-interactive`: the frame and shadow ease over
    /// `Duration.normal` on `--ease-glide`; none under Reduce Motion or on a static card.
    private var hoverAnimation: Animation? {
        guard interactive, !reduceMotion else { return nil }
        return .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.normal)
    }

    /// The fill: `glass-thin`'s surface gradient, or `glass-regular` under Full effects.
    @ViewBuilder
    private func fill(_ shape: RoundedRectangle) -> some View {
        let palette = theme.palette
        if fullEffects {
            // card.tsx: `fullEffects ? "glass-regular" : "glass-thin"`. Reduce Transparency
            // replaces the backdrop and gradient with `--card` (index.css reduced-transparency).
            if reduceTransparency {
                shape.fill(Color(token: palette.card, opacity: DesignTokens.Glass.reducedTransparencyOpacity))
            } else {
                shape
                    .fill(.regularMaterial)
                    .overlay(
                        shape.fill(
                            GlassMaterialSpec.regular.appearance(isDark: theme.isDark).fill
                                .linearGradient(selection: theme.selection)))
            }
        } else {
            shape.fill(
                LinearGradient(
                    colors: theme.isDark
                        ? [
                            Color(token: palette.glassSurface, opacity: 0.64),
                            Color(token: palette.glassSurfaceDeep, opacity: 0.78),
                        ]
                        : [
                            Color(token: palette.glassSurface, opacity: 0.72),
                            Color(token: palette.glassSurface, opacity: 0.56),
                        ],
                    startPoint: .top, endPoint: .bottom))
        }
    }
}

/// An interactive card: hover tracking, the `hover:-translate-y-0.5` lift (2 pt over
/// `Duration.fast` on `--ease-glide`; none under Reduce Motion) and the surface's hover frame
/// and shadow.
private struct VisionInteractiveCardSurface: ViewModifier {
    let cornerRadius: CGFloat
    let stroke: Color?
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .background(
                VisionCardBackground(cornerRadius: cornerRadius, stroke: stroke, hovering: hovering, interactive: true)
            )
            .offset(y: hovering && !reduceMotion ? -2 : 0)
            .animation(
                reduceMotion ? nil : .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.fast),
                value: hovering
            )
            .onHover { hovering = $0 }
    }
}

extension View {
    /// Draws the view on the web `<Card>` surface; `interactive` is the Card `interactive`
    /// variant (`premium-frame-interactive`): hover frame, lift and shadow.
    @ViewBuilder
    func visionCardBackground(
        cornerRadius: CGFloat = DesignTokens.Radius.card, stroke: Color? = nil, interactive: Bool = false
    ) -> some View {
        if interactive {
            modifier(VisionInteractiveCardSurface(cornerRadius: cornerRadius, stroke: stroke))
        } else {
            background(VisionCardBackground(cornerRadius: cornerRadius, stroke: stroke))
        }
    }

    /// A full-width card: `padding`, leading-aligned, on the web `<Card>` surface.
    func visionCard(padding: CGFloat = 20, stroke: Color? = nil, interactive: Bool = false) -> some View {
        self.padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .visionCardBackground(stroke: stroke, interactive: interactive)
    }
}

/// The page frame every native screen shares: the web `<main>` padding (`p-6`, 24 pt) and
/// `PageShell`'s 24 pt rhythm, filling the detail column's width as the web pages do.
enum VisionPageLayout {
    static let padding: CGFloat = 24
    static let spacing: CGFloat = 24
}
