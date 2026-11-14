import AppKit
import SwiftUI
import VisionNativeCore

/// The web `<Card>` surface (`card-material premium-frame rounded-card`, plus `glass-thin`, or
/// `glass-regular` under Full effects: index.css; components/ui/card.tsx): the material gradient,
/// the `--border`/0.7 frame, the embossed inset edge (a top highlight and, in light mode, a bottom
/// hairline) and the soft drop shadow. Print reports keep a flat white card with a hairline.
///
/// Both materials are drawn as Core Animation layers (`VisionCardLayers`). The web filters a
/// card's backdrop with saturate alone (`.card-material`, phase D); SwiftUI has no backdrop
/// saturate, so the card draws its fill without a backdrop filter.
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
    @Environment(\.visionVisualEffects) private var visualEffects
    /// `prefers-reduced-transparency` or the reduced tier: a fully opaque `--card` (ADR-257 I4), so
    /// the compositor culls what lies under the card.
    private var opaque: Bool { reduceTransparency || visualEffects == .reduced }
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if theme.isPrintReport {
            shape.fill(theme.card).overlay(shape.strokeBorder(stroke ?? theme.border, lineWidth: 1))
        } else {
            VisionCardLayers(style: layerStyle())
        }
    }

    private func layerStyle() -> VisionCardLayerStyle {
        let palette = theme.palette
        let dark = theme.isDark
        let lifted = interactive && hovering
        // card.tsx: `fullEffects ? "glass-regular" : "glass-thin"`.
        let material = (fullEffects ? GlassMaterialSpec.regular : GlassMaterialSpec.thin).appearance(isDark: dark)
        // `.premium-frame` sets `--border`/0.7, but in dark mode `.dark .glass-regular` (two
        // classes) outranks it with `--glass-border`/0.08; the hover frame outranks both.
        let restingFrame: Color =
            fullEffects && dark && !opaque
            ? Color(token: palette.color(material.border.color), opacity: material.border.alpha)
            : theme.border.opacity(0.7)
        // `.premium-frame-interactive:hover` frame: `--primary` at 0.4, dark 0.5.
        let frame: Color =
            stroke
            ?? (lifted
                ? theme.primary.opacity(DesignTokens.Hover.cardBorderAlpha.value(isDark: dark))
                : restingFrame)
        // `:root.fx-full .premium-frame-interactive:hover` raises the inset highlight to
        // 0.22 (dark 0.12); otherwise the resting 0.16 (dark 0.06).
        let highlightAlpha: Double = fullEffects && lifted ? (dark ? 0.12 : 0.22) : (dark ? 0.06 : 0.16)
        // `.premium-frame-interactive::after` / hover box-shadow, a fade in (index.css).
        let lift = DesignTokens.Hover.cardShadow.value(isDark: dark).first
        let liftAlpha = lifted ? (lift?.alpha ?? 0) : 0
        let fillColors: [CGColor]
        let fillLocations: [Double]
        if opaque {
            // Reduce Transparency and the reduced tier replace the gradient with `--card`.
            let card = NSColor(Color(token: palette.card, opacity: DesignTokens.Glass.reducedTransparencyOpacity)).cgColor
            fillColors = [card, card]
            fillLocations = [0, 1]
        } else {
            fillColors = material.fill.stops.map {
                NSColor(Color(token: palette.color($0.color), opacity: $0.alpha)).cgColor
            }
            fillLocations = material.fill.stops.map(\.location)
        }
        return VisionCardLayerStyle(
            cornerRadius: cornerRadius,
            fillColors: fillColors,
            fillLocations: fillLocations,
            fillAngle: material.fill.angle,
            edgeTop: NSColor(Color(token: palette.glassHighlight, opacity: highlightAlpha)).cgColor,
            edgeBottom: NSColor(Color(token: palette.glassShadow, opacity: dark ? 0 : 0.05)).cgColor,
            frame: NSColor(frame).cgColor,
            // `.premium-frame` outer shadow: `0 4px 12px shadow/0.04`, dark `0 5px 16px shadow/0.2`.
            shadows: [
                VisionCardShadow(
                    color: NSColor(Color(token: palette.glassShadow, opacity: dark ? 0.2 : 0.04)).cgColor,
                    radius: dark ? 8 : 6, x: 0, y: dark ? 5 : 4)
            ],
            lift: interactive
                ? VisionCardShadow(
                    color: NSColor(Color(token: palette.glassShadow, opacity: liftAlpha)).cgColor,
                    radius: CGFloat((lift?.blur ?? 0) / 2), x: CGFloat(lift?.x ?? 0), y: CGFloat(lift?.y ?? 0))
                : nil,
            transitionDuration: hoverAnimation == nil ? nil : DesignTokens.Duration.normal,
            transitionCurve: DesignTokens.Ease.glide)
    }

    /// `transition` of `.premium-frame-interactive`: the frame and shadow ease over
    /// `Duration.normal` on `--ease-glide`; none under Reduce Motion or on a static card.
    private var hoverAnimation: Animation? {
        guard interactive, !reduceMotion else { return nil }
        return .visionCurve(DesignTokens.Ease.glide, duration: DesignTokens.Duration.normal)
    }
}

/// A glass box that is not a `<Card>` (no `premium-frame`): the material's own fill, border, inset
/// highlight and outer elevation, as Core Animation layers. Reduce Transparency and the reduced
/// tier make it an opaque `--card`, as they do every material.
struct VisionGlassBoxBackground: View {
    let material: GlassMaterialSpec
    var cornerRadius: CGFloat = DesignTokens.Radius.card
    /// A frame that replaces the material border (an explicit `border-*` class on the box).
    var frame: Color?
    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.visionVisualEffects) private var visualEffects

    var body: some View {
        let palette = theme.palette
        let dark = theme.isDark
        let look = material.appearance(isDark: dark)
        let opaque = reduceTransparency || visualEffects == .reduced
        let card = NSColor(Color(token: palette.card, opacity: DesignTokens.Glass.reducedTransparencyOpacity)).cgColor
        let inset = look.shadows.first(where: \.inset)
        let border = frame ?? Color(token: palette.color(look.border.color), opacity: look.border.alpha)
        VisionCardLayers(
            style: VisionCardLayerStyle(
                cornerRadius: cornerRadius,
                fillColors: opaque
                    ? [card, card]
                    : look.fill.stops.map { NSColor(Color(token: palette.color($0.color), opacity: $0.alpha)).cgColor },
                fillLocations: opaque ? [0, 1] : look.fill.stops.map(\.location),
                fillAngle: look.fill.angle,
                edgeTop: NSColor(Color(token: palette.glassHighlight, opacity: inset?.alpha ?? 0)).cgColor,
                edgeBottom: CGColor.clear,
                frame: NSColor(border).cgColor,
                shadows: look.shadows.filter { !$0.inset }.map {
                    VisionCardShadow(
                        color: NSColor(Color(token: palette.color($0.color), opacity: $0.alpha)).cgColor,
                        radius: CGFloat($0.blur / 2), x: CGFloat($0.x), y: CGFloat($0.y), spread: CGFloat($0.spread))
                },
                lift: nil, transitionDuration: nil, transitionCurve: DesignTokens.Ease.glide))
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
