import Foundation

/// A gradient stop of a glass recipe: a theme colour at an alpha, `hsl(var(--glass-x) / alpha) location`.
public struct GlassStop: Equatable, Sendable {
    public let color: ThemeColorRole
    public let alpha: Double
    /// Position along the gradient line, 0 to 1.
    public let location: Double

    public init(_ color: ThemeColorRole, _ alpha: Double, at location: Double) {
        self.color = color
        self.alpha = alpha
        self.location = location
    }
}

/// A CSS `linear-gradient(angle, stops...)`.
public struct GlassGradient: Equatable, Sendable {
    /// CSS degrees: 0 points up, 90 right, 180 down (`to bottom`), 135 towards the bottom right.
    public let angle: Double
    public let stops: [GlassStop]

    public init(angle: Double, stops: [GlassStop]) {
        self.angle = angle
        self.stops = stops
    }
}

/// One appearance (light or dark) of a glass material: its fill, border and shadows.
public struct GlassAppearance: Equatable, Sendable {
    public let fill: GlassGradient
    /// The 1px border: `border: 1px solid hsl(role / alpha)`.
    public let border: GlassStop
    /// The material's box-shadow layers, an inset highlight first (see `DesignTokens.Elevation`).
    public let shadows: [ShadowLayer]

    public init(fill: GlassGradient, border: GlassStop, shadows: [ShadowLayer]) {
        self.fill = fill
        self.border = border
        self.shadows = shadows
    }
}

/// A glass material of the web app (apps/frontend/src/index.css, "Glass materials" section) as
/// data: the gradient fill, border and elevation per appearance, and the backdrop blur and
/// saturation. Colours are theme roles, so every theme variant keeps its own glass hue; blur
/// radii are points and come from `DesignTokens.Glass`.
///
/// Depth follows the elevation tokens as in the CSS: thin reads `Elevation.level1`, regular 2,
/// elevated 3, thick 4. The `.glass` base recipe and its specular `::before` layer are not
/// modelled: no Card or primitive uses them.
public struct GlassMaterialSpec: Equatable, Sendable {
    /// The CSS class the recipe mirrors, e.g. `glass-thick`.
    public let name: String
    /// `backdrop-filter: blur(...)`, in points.
    public let blur: Double
    /// `backdrop-filter: saturate(...)`, as a multiplier.
    public let saturate: AppearanceValue<Double>
    public let light: GlassAppearance
    public let dark: GlassAppearance

    public init(
        name: String, blur: Double, saturate: AppearanceValue<Double> = DesignTokens.Glass.saturate,
        light: GlassAppearance, dark: GlassAppearance
    ) {
        self.name = name
        self.blur = blur
        self.saturate = saturate
        self.light = light
        self.dark = dark
    }

    public func appearance(isDark: Bool) -> GlassAppearance { isDark ? dark : light }
}

extension GlassMaterialSpec {
    /// `.glass-thin`: default Cards and subtle standalone controls (index.css `.glass-thin`).
    public static let thin = GlassMaterialSpec(
        name: "glass-thin", blur: DesignTokens.Glass.thinBlur,
        light: GlassAppearance(
            fill: GlassGradient(
                angle: 180,
                stops: [GlassStop(.surface, 0.72, at: 0), GlassStop(.surface, 0.56, at: 1)]),
            border: GlassStop(.border, 0.08, at: 0),
            shadows: DesignTokens.Elevation.level1.light),
        dark: GlassAppearance(
            fill: GlassGradient(
                angle: 180,
                stops: [GlassStop(.surface, 0.64, at: 0), GlassStop(.surfaceDeep, 0.78, at: 1)]),
            border: GlassStop(.border, 0.08, at: 0),
            shadows: DesignTokens.Elevation.level1.dark))

    /// `.glass-regular`: an explicitly stronger content material, the Card under Full effects
    /// (index.css `.glass-regular`).
    public static let regular = GlassMaterialSpec(
        name: "glass-regular", blur: DesignTokens.Glass.regularBlur,
        light: GlassAppearance(
            fill: GlassGradient(
                angle: 135,
                stops: [
                    GlassStop(.highlight, 0.38, at: 0), GlassStop(.surface, 0.7, at: 0.42),
                    GlassStop(.surface, 0.52, at: 1),
                ]),
            border: GlassStop(.border, 0.1, at: 0),
            shadows: DesignTokens.Elevation.level2.light),
        dark: GlassAppearance(
            fill: GlassGradient(
                angle: 135,
                stops: [
                    GlassStop(.highlight, 0.04, at: 0), GlassStop(.surface, 0.78, at: 0.42),
                    GlassStop(.surfaceDeep, 0.9, at: 1),
                ]),
            border: GlassStop(.border, 0.08, at: 0),
            shadows: DesignTokens.Elevation.level2.dark))

    /// `.glass-thick`: dialogs, popovers and important overlays (index.css `.glass-thick`).
    public static let thick = GlassMaterialSpec(
        name: "glass-thick", blur: DesignTokens.Glass.thickBlur,
        light: GlassAppearance(
            fill: GlassGradient(
                angle: 135,
                stops: [
                    GlassStop(.highlight, 0.5, at: 0), GlassStop(.surface, 0.82, at: 0.4),
                    GlassStop(.surfaceDeep, 0.7, at: 1),
                ]),
            border: GlassStop(.border, 0.14, at: 0),
            shadows: DesignTokens.Elevation.level4.light),
        dark: GlassAppearance(
            fill: GlassGradient(
                angle: 135,
                stops: [
                    GlassStop(.highlight, 0.06, at: 0), GlassStop(.surface, 0.86, at: 0.42),
                    GlassStop(.surfaceDeep, 0.94, at: 1),
                ]),
            border: GlassStop(.border, 0.1, at: 0),
            shadows: DesignTokens.Elevation.level4.dark))

    /// `.glass-chrome`: the sidebar rail and persistent toolbars (index.css `.glass-chrome`). Its
    /// shadows are its own, not an elevation level; `ShellGlass` draws the native sidebar.
    public static let chrome = GlassMaterialSpec(
        name: "glass-chrome", blur: DesignTokens.Glass.chromeBlur,
        light: GlassAppearance(
            fill: GlassGradient(
                angle: 180,
                stops: [GlassStop(.sidebarBackground, 0.55, at: 0), GlassStop(.sidebarBackground, 0.72, at: 1)]),
            border: GlassStop(.sidebarBorder, 0.5, at: 0),
            shadows: [
                ShadowLayer(color: .highlight, alpha: 0.28, x: 0, y: 1, blur: 0, spread: 0, inset: true),
                ShadowLayer(color: .shadow, alpha: 0.08, x: 0, y: 18, blur: 48, spread: 0, inset: false),
            ]),
        dark: GlassAppearance(
            fill: GlassGradient(
                angle: 180,
                stops: [GlassStop(.sidebarBackground, 0.55, at: 0), GlassStop(.sidebarBackground, 0.74, at: 1)]),
            border: GlassStop(.sidebarBorder, 0.6, at: 0),
            shadows: [
                ShadowLayer(color: .highlight, alpha: 0.06, x: 0, y: 1, blur: 0, spread: 0, inset: true),
                ShadowLayer(color: .shadow, alpha: 0.45, x: 0, y: 20, blur: 56, spread: 0, inset: false),
            ]))

    /// `.glass-elevated`: hero tiles and featured KPIs (index.css `.glass-elevated`).
    public static let elevated = GlassMaterialSpec(
        name: "glass-elevated", blur: DesignTokens.Glass.elevatedBlur,
        light: GlassAppearance(
            fill: GlassGradient(
                angle: 138,
                stops: [
                    GlassStop(.highlight, 0.62, at: 0), GlassStop(.surface, 0.78, at: 0.38),
                    GlassStop(.tint, 0.08, at: 1),
                ]),
            border: GlassStop(.border, 0.16, at: 0),
            shadows: DesignTokens.Elevation.level3.light),
        dark: GlassAppearance(
            fill: GlassGradient(
                angle: 138,
                stops: [
                    GlassStop(.highlight, 0.1, at: 0), GlassStop(.surface, 0.84, at: 0.36),
                    GlassStop(.tint, 0.22, at: 1),
                ]),
            border: GlassStop(.border, 0.12, at: 0),
            shadows: DesignTokens.Elevation.level3.dark))
}

extension ThemePalette {
    /// The palette colour a shadow or gradient stop names.
    public func color(_ role: ThemeColorRole) -> HSLColor {
        switch role {
        case .highlight: return glassHighlight
        case .shadow: return glassShadow
        case .surface: return glassSurface
        case .surfaceSoft: return glassSurfaceSoft
        case .surfaceDeep: return glassSurfaceDeep
        case .tint: return glassTint
        case .border: return glassBorder
        case .sidebarBackground: return sidebarBackground
        case .sidebarBorder: return sidebarBorder
        case .background: return background
        case .foreground: return foreground
        case .primary: return primary
        }
    }
}

extension ThemeSelection {
    /// The colour a shadow or gradient stop names; `primary` follows the system accent override.
    public func color(_ role: ThemeColorRole) -> HSLColor {
        role == .primary ? primary : palette.color(role)
    }
}
