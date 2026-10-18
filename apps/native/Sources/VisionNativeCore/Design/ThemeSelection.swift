import Foundation

/// The web app's active theme as native screens use it: the variant and the resolved
/// appearance, plus the colorblind-safe gain/loss skin from `app_settings`.
public struct ThemeSelection: Equatable, Sendable {
    public var variant: ThemeVariant
    public var appearance: ThemeAppearance
    public var colorblindGainLoss: Bool
    /// The current macOS accent when the system-accent setting is enabled. Palette swatches stay canonical.
    public var systemAccentColor: HSLColor?
    /// The foreground selected from the original accent RGB bytes before rounded HSL conversion.
    public var systemAccentForegroundColor: HSLColor?

    public init(
        variant: ThemeVariant = .default, appearance: ThemeAppearance, colorblindGainLoss: Bool = false,
        systemAccentColor: HSLColor? = nil, systemAccentForegroundColor: HSLColor? = nil
    ) {
        self.variant = variant
        self.appearance = appearance
        self.colorblindGainLoss = colorblindGainLoss
        self.systemAccentColor = systemAccentColor
        self.systemAccentForegroundColor = systemAccentForegroundColor
    }

    public var palette: ThemePalette { DesignTokens.palette(variant, appearance) }

    /// ThemeHydration overrides only these six semantic tokens, not the base palette or --accent.
    public var primary: HSLColor { systemAccentColor ?? palette.primary }
    public var primaryForeground: HSLColor {
        guard let systemAccentColor else { return palette.primaryForeground }
        return systemAccentForegroundColor ?? AccentColor.foreground(for: systemAccentColor)
    }
    public var ring: HSLColor { systemAccentColor ?? palette.ring }
    public var sidebarPrimary: HSLColor { systemAccentColor ?? palette.sidebarPrimary }
    public var sidebarPrimaryForeground: HSLColor {
        systemAccentColor == nil ? palette.sidebarPrimaryForeground : primaryForeground
    }
    public var sidebarRing: HSLColor { systemAccentColor ?? palette.sidebarRing }

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

/// The source macOS-accent primary and its contrasting foreground, derived from the same RGB bytes.
public struct SystemAccentTokens: Equatable, Sendable {
    public let color: HSLColor
    public let foreground: HSLColor
}
extension AccentColor {
    /// lib/accentColor.ts hexToHslComponents + accentForegroundComponents; alpha is intentionally ignored.
    public static func themeTokens(hex: String) -> SystemAccentTokens? {
        let whitespace = CharacterSet(
            charactersIn:
                "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
        )
        let value = hex.trimmingCharacters(in: whitespace)
        guard value.range(of: "\\A#?[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?\\z", options: .regularExpression) != nil else {
            return nil
        }
        let digits = value.hasPrefix("#") ? String(value.dropFirst()) : value
        guard let rgb = UInt32(digits.prefix(6), radix: 16) else { return nil }
        let red = Double((rgb >> 16) & 255) / 255
        let green = Double((rgb >> 8) & 255) / 255
        let blue = Double(rgb & 255) / 255
        let maximum = max(red, green, blue)
        let minimum = min(red, green, blue)
        let lightness = (maximum + minimum) / 2
        let delta = maximum - minimum
        var hue = 0.0
        var saturation = 0.0
        if delta != 0 {
            saturation = delta / (1 - abs(2 * lightness - 1))
            if maximum == red {
                hue = ((green - blue) / delta).truncatingRemainder(dividingBy: 6)
            } else if maximum == green {
                hue = (blue - red) / delta + 2
            } else {
                hue = (red - green) / delta + 4
            }
            hue *= 60
            if hue < 0 { hue += 360 }
        }
        return .init(
            color: .init(
                hue: hue.rounded(), saturation: (saturation * 100).rounded(), lightness: (lightness * 100).rounded()),
            foreground: foreground(red: red, green: green, blue: blue))
    }
    /// Direct HSL callers have no original RGB bytes. SDK callers should supply the paired themeTokens foreground.
    public static func foreground(for color: HSLColor) -> HSLColor {
        let rgb = color.rgb
        return foreground(red: rgb.red, green: rgb.green, blue: rgb.blue)
    }
    private static func foreground(red: Double, green: Double, blue: Double) -> HSLColor {
        func linear(_ component: Double) -> Double {
            component <= 0.03928 ? component / 12.92 : pow((component + 0.055) / 1.055, 2.4)
        }
        let luminance = 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        let whiteContrast = 1.05 / (luminance + 0.05)
        let blackContrast = (luminance + 0.05) / 0.05
        return whiteContrast >= blackContrast
            ? .init(hue: 0, saturation: 0, lightness: 100)
            : .init(hue: 224, saturation: 47, lightness: 10)
    }
}
