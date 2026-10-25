import Foundation

/// An HSL colour from CSS component strings ("158 64% 52%").
public struct HSLColor: Equatable, Sendable {
    public let hue: Double
    public let saturation: Double
    public let lightness: Double

    public init(hue: Double, saturation: Double, lightness: Double) {
        self.hue = hue
        self.saturation = saturation
        self.lightness = lightness
    }

    public static func parse(_ components: String) -> HSLColor? {
        guard SplashTheme.isValidHSLComponents(components) else { return nil }
        let parts = components.split(whereSeparator: { $0.isWhitespace }).map {
            Double($0.replacingOccurrences(of: "%", with: ""))
        }
        guard parts.count == 3, let hue = parts[0], let saturation = parts[1], let lightness = parts[2] else {
            return nil
        }
        return HSLColor(hue: hue, saturation: saturation, lightness: lightness)
    }

    /// sRGB components from 0 to 1, with the formula of `hslToHex` in main.ts.
    public var rgb: (red: Double, green: Double, blue: Double) {
        let s = saturation / 100
        let l = lightness / 100
        let a = s * min(l, 1 - l)
        func channel(_ n: Double) -> Double {
            let k = (n + hue / 30).truncatingRemainder(dividingBy: 12)
            return l - a * max(-1, min(k - 3, min(9 - k, 1)))
        }
        return (channel(0), channel(8), channel(4))
    }

    /// `hslToHex`: `#rrggbb`.
    public var hex: String {
        let (red, green, blue) = rgb
        return "#" + [red, green, blue].map { component in
            let value = Int((255 * component).rounded())
            let text = String(value, radix: 16)
            return text.count == 1 ? "0" + text : text
        }.joined()
    }
}

/// The launch screen and window backdrop colours (`deriveSplashPalette`).
public struct LaunchPalette: Equatable, Sendable {
    public let base: HSLColor
    public let glow: HSLColor
    public let foreground: HSLColor
    /// The light-theme branch: the persisted surface and text colours.
    public let isLight: Bool
}

public enum LaunchAppearance {
    public static let splashThemeKey = "splashTheme"
    /// `DEFAULT_BRAND_PRIMARY`.
    public static let defaultBrandPrimary = "158 64% 52%"
    /// `splashBackgroundColor`'s fallback.
    public static let fallbackBase = HSLColor(hue: 158, saturation: 45, lightness: 6)

    /// `readSplashTheme`: the persisted theme, validated again on read.
    public static func theme(fromSettings settings: [String: JSONValue]) -> SplashTheme? {
        SplashTheme.parse(settings[splashThemeKey])
    }

    /// A light theme uses its own surface and text; otherwise the window is a near-black
    /// base carrying the primary's hue, with light text.
    public static func palette(theme: SplashTheme?) -> LaunchPalette {
        let primaryText = theme?.background ?? defaultBrandPrimary
        let primary = HSLColor.parse(primaryText) ?? HSLColor.parse(defaultBrandPrimary)!
        if theme?.mode == .light, let surface = theme?.surface.flatMap(HSLColor.parse),
            let text = theme?.text.flatMap(HSLColor.parse)
        {
            return LaunchPalette(base: surface, glow: primary, foreground: text, isLight: true)
        }
        let saturation = primary.saturation
        return LaunchPalette(
            base: HSLColor(hue: primary.hue, saturation: min(saturation, 45).rounded(), lightness: 6),
            glow: primary,
            foreground: HSLColor(hue: primary.hue, saturation: min(saturation, 24).rounded(), lightness: 88),
            isLight: false)
    }

    /// The splash status key for a runtime phase (`setSplashStatus` in `launch()`).
    public static func statusKey(for phase: RuntimePhase) -> String {
        switch phase {
        case .startingBackend:
            return "splash.startingServices"
        case .waitingForReadiness, .running:
            return "splash.waitingApp"
        default:
            return "splash.starting"
        }
    }
}

/// `systemPreferences.getAccentColor()`: lowercase `rrggbbaa`.
public enum AccentColor {
    public static func hex(red: Double, green: Double, blue: Double, alpha: Double) -> String {
        [red, green, blue, alpha].map { component in
            let value = Int((max(0, min(1, component)) * 255).rounded())
            let text = String(value, radix: 16)
            return text.count == 1 ? "0" + text : text
        }.joined()
    }
}

/// The dock badge for the planned-payment count (`app.dock.setBadge`): the number, or no
/// badge for zero. The count is already clamped to 0...999 by the bridge.
public enum DockBadge {
    public static func label(for count: Int) -> String? {
        count > 0 ? String(count) : nil
    }
}

/// Electron's zoom roles: each step changes the zoom level by 0.5, where the factor is
/// 1.2^level, between Chromium's 25 % and 500 %.
public enum PageZoom {
    public static let minimumFactor = 0.25
    public static let maximumFactor = 5.0

    public static func level(forFactor factor: Double) -> Double {
        guard factor > 0 else { return 0 }
        return (log(factor) / log(1.2) * 2).rounded() / 2
    }

    public static func factor(forLevel level: Double) -> Double {
        min(maximumFactor, max(minimumFactor, pow(1.2, level)))
    }

    public static func zoomedIn(from factor: Double) -> Double {
        self.factor(forLevel: level(forFactor: factor) + 0.5)
    }

    public static func zoomedOut(from factor: Double) -> Double {
        self.factor(forLevel: level(forFactor: factor) - 0.5)
    }

    /// Chromium remembers the page zoom across launches; native keeps it in settings.json.
    public static let settingsKey = "nativePageZoom"

    /// A stored factor snapped to a zoom step; anything missing or invalid is 100%.
    public static func persisted(_ value: JSONValue?) -> Double {
        let raw: Double
        switch value {
        case .double(let number): raw = number
        case .int(let number): raw = Double(number)
        default: return 1
        }
        guard raw.isFinite, raw > 0 else { return 1 }
        return factor(forLevel: level(forFactor: raw))
    }
}

/// What a double-click on the drag region does: the system setting "Double-click a window's
/// title bar to" (`AppleActionOnDoubleClick`).
public enum TitlebarDoubleClickAction: Equatable, Sendable {
    case zoom
    case minimize
    case none

    public static func from(userDefault value: String?) -> TitlebarDoubleClickAction {
        switch value {
        case "Minimize": return .minimize
        case "None": return .none
        default: return .zoom
        }
    }
}
