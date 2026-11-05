import Foundation

/// The web shell's glass look for the native shell: `.glass-chrome` of the sidebar rail and
/// the active menu button (apps/frontend/src/index.css, components/ui/sidebar.tsx), from
/// the design tokens of the active theme.
public struct ShellGlass: Equatable, Sendable {
    /// `--sidebar-background` at the top and bottom of the chrome gradient.
    public let sidebarTop: HSLColor
    public let sidebarTopOpacity: Double
    public let sidebarBottomOpacity: Double
    /// `border-sidebar-border/60` on the rail edge (`.glass-chrome` 0.5, dark 0.6).
    public let border: HSLColor
    public let borderOpacity: Double
    /// `--glass-highlight`: the inset top line (0.28, dark 0.06).
    public let highlight: HSLColor
    public let highlightOpacity: Double
    /// `data-[active=true]:bg-primary/[0.12]`, dark `/[0.16]`: the active row's pill.
    public let selection: HSLColor
    public let selectionOpacity: Double
    /// `[&>svg]:text-primary`: the row icons.
    public let icon: HSLColor
    public let foreground: HSLColor
    /// `--background` over the behind-window material of the detail column: enough to keep
    /// the page colour, little enough that the desktop glows through like Electron's
    /// vibrancy behind the translucent page.
    public let detailTint: HSLColor
    public let detailTintOpacity: Double

    /// `backdrop-filter: blur(...)` of `.glass-chrome` in points (`DesignTokens.Glass.chromeBlur`).
    public let blur: Double
    /// `backdrop-filter: saturate(...)` of `.glass-chrome` (`DesignTokens.Glass.saturate`).
    public let saturate: Double

    public init(selection theme: ThemeSelection) {
        let palette = theme.palette
        let dark = theme.appearance == .dark
        // `.glass-chrome` (index.css) as data: gradient stops, rail border and inset highlight.
        let chrome = GlassMaterialSpec.chrome
        let recipe = chrome.appearance(isDark: dark)
        sidebarTop = palette.sidebarBackground
        sidebarTopOpacity = recipe.fill.stops.first?.alpha ?? 0.55
        sidebarBottomOpacity = recipe.fill.stops.last?.alpha ?? (dark ? 0.74 : 0.72)
        border = palette.sidebarBorder
        borderOpacity = recipe.border.alpha
        highlight = palette.glassHighlight
        highlightOpacity = recipe.shadows.first(where: { $0.inset })?.alpha ?? (dark ? 0.06 : 0.28)
        blur = chrome.blur
        saturate = chrome.saturate.value(isDark: dark)
        self.selection = theme.primary
        selectionOpacity = dark ? 0.16 : 0.12
        icon = theme.primary
        foreground = palette.sidebarForeground
        detailTint = palette.background
        detailTintOpacity = dark ? 0.84 : 0.86
    }
}
