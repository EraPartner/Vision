import SwiftUI
import VisionNativeCore

/// The effective visual-effects tier (`reduced`, `standard`, `enhanced`) as a type
/// (hooks/useVisualEffectsTier.ts). The settings model publishes the tier as the core
/// `VisualEffects` in `EnvironmentValues.visionVisualEffects`; `visionEffectsTier` reads it as this enum.
public enum VisualEffectsTier: String, Sendable {
    case reduced
    case standard
    case enhanced

    /// The tier a settings string names; anything unknown is `standard`, the web default.
    public init(setting: VisualEffects) {
        self = VisualEffectsTier(rawValue: setting.rawValue) ?? .standard
    }
}

extension EnvironmentValues {
    /// `AppSettings.fullEffects` (`:root.fx-full`, components/layout/VisualEffectsController.tsx;
    /// `useFullEffects`, hooks/useVisualEffectsTier.ts): restores the effects ADR-244 removed
    /// to save GPU work. Off by default; the shell sets it.
    @Entry public var visionFullEffects: Bool = false

    /// The tier as a type, bridged from the `VisualEffects` key `visionVisualEffects`.
    public var visionEffectsTier: VisualEffectsTier {
        get { VisualEffectsTier(setting: visionVisualEffects) }
        set { visionVisualEffects = VisualEffects(rawValue: newValue.rawValue) }
    }
}

/// Which web rule a text halo follows.
public enum CanvasTextHaloScope: Sendable {
    /// `PageHeader`'s title and subtitle: the single halo in dark mode always
    /// (`.dark .page-header-title`, index.css), the double halo under Full effects.
    case pageHeader
    /// Other headings and `.canvas-text`: the double halo, only under Full effects
    /// (`.dark.fx-full h1, h2, h3, .font-display, .canvas-text`, index.css).
    case canvasText
}

/// The dark-mode `text-shadow` in `--background` that keeps text legible over the aurora
/// (index.css "Canvas-text legibility guarantee" and `.dark.fx-full h1`). Light mode needs none.
public struct VisionCanvasTextHalo: ViewModifier {
    public let scope: CanvasTextHaloScope
    @Environment(\.visionTheme) private var theme
    @Environment(\.visionFullEffects) private var fullEffects

    public init(scope: CanvasTextHaloScope) {
        self.scope = scope
    }

    @ViewBuilder
    public func body(content: Content) -> some View {
        let inner = DesignTokens.Halo.fullInner
        let outer = DesignTokens.Halo.fullOuter
        let single = DesignTokens.Halo.single
        if !theme.isDark {
            content
        } else if fullEffects {
            content
                .shadow(color: color(inner), radius: inner.blur / 2, x: inner.x, y: inner.y)
                .shadow(color: color(outer), radius: outer.blur / 2, x: outer.x, y: outer.y)
        } else if scope == .pageHeader {
            content.shadow(color: color(single), radius: single.blur / 2, x: single.x, y: single.y)
        } else {
            content
        }
    }

    private func color(_ layer: ShadowLayer) -> Color {
        Color(token: theme.selection.color(layer.color), opacity: layer.alpha)
    }
}

extension View {
    /// The canvas-text halo of `scope` (see `VisionCanvasTextHalo`).
    public func visionCanvasTextHalo(_ scope: CanvasTextHaloScope = .pageHeader) -> some View {
        modifier(VisionCanvasTextHalo(scope: scope))
    }
}

extension GlassGradient {
    /// This CSS gradient as a SwiftUI gradient in the theme's colours, along the gradient line
    /// of the CSS `angle` (0 up, 90 right, 180 down) for a box.
    func linearGradient(selection: ThemeSelection) -> LinearGradient {
        let radians = angle * Double.pi / 180
        let dx = sin(radians)
        let dy = -cos(radians)
        let scale = max(abs(dx), abs(dy))
        let ux = dx / scale
        let uy = dy / scale
        return LinearGradient(
            stops: stops.map {
                Gradient.Stop(color: Color(token: selection.color($0.color), opacity: $0.alpha), location: $0.location)
            },
            startPoint: UnitPoint(x: 0.5 - ux / 2, y: 0.5 - uy / 2),
            endPoint: UnitPoint(x: 0.5 + ux / 2, y: 0.5 + uy / 2))
    }
}
