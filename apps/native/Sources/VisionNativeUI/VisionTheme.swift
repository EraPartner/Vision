import SwiftUI
import VisionNativeCore

/// The web app's active theme for SwiftUI: the generated palette of the variant and
/// appearance the page last reported (`ThemeSelection`, from `splashTheme`).
public struct VisionTheme: Equatable, Sendable {
    public var selection: ThemeSelection
    public let isPrintReport: Bool

    public init(selection: ThemeSelection, isPrintReport: Bool = false) {
        self.selection = selection
        self.isPrintReport = isPrintReport
    }

    public static let fallback = VisionTheme(selection: ThemeSelection(appearance: .light))

    public var palette: ThemePalette { selection.palette }
    public var isDark: Bool { !isPrintReport && selection.appearance == .dark }
    public var colorScheme: ColorScheme { isDark ? .dark : .light }

    private var foregroundToken: HSLColor {
        isPrintReport ? HSLColor(hue: 210, saturation: 12, lightness: 10) : palette.foreground
    }
    public var background: Color { isPrintReport ? .white : Color(token: palette.background) }
    public var foreground: Color { Color(token: foregroundToken) }
    /// `text-label-secondary`.
    public var secondaryLabel: Color { Color(token: foregroundToken, opacity: palette.labelSecondaryAlpha) }
    /// `text-label-tertiary`.
    public var tertiaryLabel: Color { Color(token: foregroundToken, opacity: palette.labelTertiaryAlpha) }
    public var card: Color { isPrintReport ? .white : Color(token: palette.card) }
    public var border: Color {
        Color(token: isPrintReport ? HSLColor(hue: 210, saturation: 10, lightness: 76) : palette.border)
    }
    public var primary: Color { Color(token: selection.primary) }
    public var primaryForeground: Color { Color(token: selection.primaryForeground) }
    public var ring: Color { Color(token: selection.ring) }
    public var sidebarPrimary: Color { Color(token: selection.sidebarPrimary) }
    public var sidebarPrimaryForeground: Color { Color(token: selection.sidebarPrimaryForeground) }
    public var sidebarRing: Color { Color(token: selection.sidebarRing) }
    /// --accent stays the variant's canonical color; system accent changes the primary/ring family only.
    public var accent: Color { Color(token: palette.accent) }
    public var accentForeground: Color { Color(token: palette.accentForeground) }
    public var destructive: Color { Color(token: palette.destructive) }
    public var success: Color { Color(token: palette.success) }
    public var warning: Color { Color(token: palette.warning) }
    public var info: Color { Color(token: palette.info) }
    public var muted: Color {
        Color(token: isPrintReport ? HSLColor(hue: 40, saturation: 12, lightness: 94) : palette.muted)
    }
    public var mutedForeground: Color {
        isPrintReport ? Color(token: HSLColor(hue: 210, saturation: 8, lightness: 34)) : secondaryLabel
    }
    /// The sidebar and detail-column glass of the native shell.
    public var glass: ShellGlass { ShellGlass(selection: selection) }
    public var gain: Color { Color(token: selection.gain) }
    public var loss: Color { Color(token: selection.loss) }
}

extension Color {
    /// A design token: `hsl(var(--token) / opacity)`.
    public init(token: HSLColor, opacity: Double = 1) {
        let rgb = token.rgb
        self.init(.sRGB, red: rgb.red, green: rgb.green, blue: rgb.blue, opacity: opacity)
    }
}

extension EnvironmentValues {
    /// The theme native screens draw with; `ShellRootView` sets it from the shell model.
    @Entry public var visionTheme: VisionTheme = VisionTheme.fallback
}
