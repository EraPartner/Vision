import SwiftUI
import VisionNativeCore

/// A web glass material (`glass-thin`, `-regular`, `-thick`, `-chrome`, `-elevated`, index.css)
/// drawn as a view: a system `Material` backdrop under the recipe's gradient fill, the elevation's
/// inset highlight, the 1 pt border and the drop shadows, all from `GlassMaterialSpec` and the
/// active theme. Use it as a `background`:
///
///     content.background(VisionGlassSurface(material: .thick, cornerRadius: DesignTokens.Overlay.dialogRadius))
///
/// - Reduce Transparency replaces the material and gradient with `--card` at
///   `DesignTokens.Glass.reducedTransparencyOpacity` and keeps border and shadows, like the
///   `prefers-reduced-transparency: reduce` block of index.css.
/// - Increase Contrast swaps the border for `--foreground` at
///   `DesignTokens.Glass.highContrastBorderAlpha` (`prefers-contrast: more`).
/// - Print reports keep a flat white card with a hairline, as `VisionCardBackground` does.
///
/// Approximations, because SwiftUI has no CSS backdrop filter or shadow spread: the backdrop is the
/// system material nearest the recipe's blur (thin, regular, thick) and does not apply the
/// recipe's saturation; CSS shadow blur maps to a SwiftUI radius of half the blur; the negative
/// spread of the ambient layers is not applied; and each drop shadow is cast by the surface drawn
/// so far, so stacked layers add a little to each other.
public struct VisionGlassSurface: View {
    public let material: GlassMaterialSpec
    public let cornerRadius: CGFloat

    @Environment(\.visionTheme) private var theme
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.colorSchemeContrast) private var contrast

    public init(material: GlassMaterialSpec, cornerRadius: CGFloat = DesignTokens.Radius.card) {
        self.material = material
        self.cornerRadius = cornerRadius
    }

    public var body: some View {
        let shape = RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
        if theme.isPrintReport {
            shape.fill(theme.card).overlay(shape.strokeBorder(theme.border, lineWidth: 1))
        } else {
            glass(shape)
        }
    }

    private func glass(_ shape: RoundedRectangle) -> some View {
        let recipe = material.appearance(isDark: theme.isDark)
        let insets = recipe.shadows.filter { $0.inset }
        let drops = recipe.shadows.filter { !$0.inset }
        return base(shape, recipe: recipe)
            .overlay {
                ForEach(0..<insets.count, id: \.self) { index in
                    insetEdge(shape, layer: insets[index])
                }
            }
            .overlay(shape.strokeBorder(borderColor(recipe), lineWidth: 1))
            .modifier(GlassDropShadows(layers: drops.map(dropShadow)))
    }

    @ViewBuilder
    private func base(_ shape: RoundedRectangle, recipe: GlassAppearance) -> some View {
        if reduceTransparency {
            shape.fill(Color(token: theme.palette.card, opacity: DesignTokens.Glass.reducedTransparencyOpacity))
        } else {
            shape
                .fill(backdrop)
                .overlay(
                    shape.fill(
                        LinearGradient(
                            stops: recipe.fill.stops.map {
                                Gradient.Stop(color: color($0.color, $0.alpha), location: $0.location)
                            },
                            startPoint: recipe.fill.startPoint, endPoint: recipe.fill.endPoint)))
        }
    }

    /// An inset `0 Ypx 0` highlight or hairline: a 1 pt edge on the side the offset points from,
    /// fading out over the first eighth of the surface (as `VisionCardBackground`'s embossed edge).
    private func insetEdge(_ shape: RoundedRectangle, layer: ShadowLayer) -> some View {
        let edge = color(layer.color, layer.alpha)
        let fromTop = layer.y >= 0
        return shape.strokeBorder(
            LinearGradient(
                stops: [
                    Gradient.Stop(color: edge, location: 0),
                    Gradient.Stop(color: edge.opacity(0), location: 0.12),
                ],
                startPoint: fromTop ? .top : .bottom, endPoint: fromTop ? .bottom : .top),
            lineWidth: max(abs(layer.y), 1))
    }

    private func dropShadow(_ layer: ShadowLayer) -> GlassDropShadows.Layer {
        GlassDropShadows.Layer(
            color: color(layer.color, layer.alpha), radius: layer.blur / 2, x: layer.x, y: layer.y)
    }

    private func borderColor(_ recipe: GlassAppearance) -> Color {
        contrast == .increased
            ? color(.foreground, DesignTokens.Glass.highContrastBorderAlpha)
            : color(recipe.border.color, recipe.border.alpha)
    }

    private func color(_ role: ThemeColorRole, _ alpha: Double) -> Color {
        Color(token: theme.selection.color(role), opacity: alpha)
    }

    /// The system material nearest the recipe's blur: thin up to `Glass.thinBlur`, regular up to
    /// the chrome blur, thick above.
    private var backdrop: Material {
        if material.blur <= DesignTokens.Glass.thinBlur { return .thinMaterial }
        if material.blur <= DesignTokens.Glass.chromeBlur { return .regularMaterial }
        return .thickMaterial
    }
}

/// Casts a stack of drop shadows, one `.shadow` per layer.
private struct GlassDropShadows: ViewModifier {
    struct Layer {
        let color: Color
        let radius: Double
        let x: Double
        let y: Double
    }

    let layers: [Layer]

    func body(content: Content) -> some View {
        layers.reduce(AnyView(content)) { view, layer in
            AnyView(view.shadow(color: layer.color, radius: layer.radius, x: layer.x, y: layer.y))
        }
    }
}

extension GlassGradient {
    /// The CSS gradient line of `angle` for a box: from the corner or edge midpoint the angle
    /// points away from to the one it points to.
    fileprivate var unitVector: (x: Double, y: Double) {
        let radians = angle * Double.pi / 180
        let dx = sin(radians)
        let dy = -cos(radians)
        let scale = max(abs(dx), abs(dy))
        return (dx / scale, dy / scale)
    }

    fileprivate var startPoint: UnitPoint {
        UnitPoint(x: 0.5 - unitVector.x / 2, y: 0.5 - unitVector.y / 2)
    }

    fileprivate var endPoint: UnitPoint {
        UnitPoint(x: 0.5 + unitVector.x / 2, y: 0.5 + unitVector.y / 2)
    }
}

extension Animation {
    /// A web spring (`DesignTokens.Spring`) with the physics of `lib/motion.ts`. Views skip it
    /// under Reduce Motion.
    public static func visionSpring(_ spring: SpringToken) -> Animation {
        .interpolatingSpring(mass: spring.mass, stiffness: spring.stiffness, damping: spring.damping)
    }

    /// A web easing (`DesignTokens.Ease`) over `duration` seconds.
    public static func visionCurve(_ curve: BezierCurve, duration: Double) -> Animation {
        .timingCurve(curve.x1, curve.y1, curve.x2, curve.y2, duration: duration)
    }
}
