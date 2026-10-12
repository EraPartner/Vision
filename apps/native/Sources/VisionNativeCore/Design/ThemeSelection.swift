import Foundation

/// The web app's active theme as native screens use it: the variant and the resolved
/// appearance, plus the colorblind-safe gain/loss skin from `app_settings`.
public struct ThemeSelection: Equatable, Sendable {
    public var variant: ThemeVariant
    public var appearance: ThemeAppearance
    public var colorblindGainLoss: Bool

    public init(variant: ThemeVariant = .default, appearance: ThemeAppearance, colorblindGainLoss: Bool = false) {
        self.variant = variant
        self.appearance = appearance
        self.colorblindGainLoss = colorblindGainLoss
    }

    public var palette: ThemePalette { DesignTokens.palette(variant, appearance) }

    /// `--gain` with the active skin.
    public var gain: HSLColor { colorblindGainLoss ? palette.colorblindGain : palette.gain }
    /// `--loss` with the active skin.
    public var loss: HSLColor { colorblindGainLoss ? palette.colorblindLoss : palette.loss }

    /// The theme the page last reported through `theme:persist-splash` (`splashTheme` in
    /// `settings.json`, see `LaunchAppearance`). The page sends the resolved mode and the
    /// variant's `--background` and `--foreground` as `surface` and `text`; the variant is
    /// the one whose palette has those two colours in that mode (its primary can differ when
    /// the macOS accent colour is on). Without a persisted theme the system appearance and
    /// the default variant apply, like a first web launch.
    public static func resolve(splashTheme: SplashTheme?, systemIsDark: Bool) -> ThemeSelection {
        let appearance: ThemeAppearance
        switch splashTheme?.mode {
        case .light?: appearance = .light
        case .dark?: appearance = .dark
        case nil: appearance = systemIsDark ? .dark : .light
        }
        guard let splashTheme, let surface = splashTheme.surface.flatMap(HSLColor.parse),
            let text = splashTheme.text.flatMap(HSLColor.parse)
        else {
            return ThemeSelection(variant: .default, appearance: appearance)
        }
        let variant = ThemeVariant.allCases.first { variant in
            let palette = DesignTokens.palette(variant, appearance)
            return palette.background == surface && palette.foreground == text
        }
        return ThemeSelection(variant: variant ?? .default, appearance: appearance)
    }
}
