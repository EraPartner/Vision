import SwiftUI
import VisionNativeCore

/// The web app's active theme for SwiftUI: the generated palette of the variant and
/// appearance the page last reported (`ThemeSelection`, from `splashTheme`).
public struct VisionTheme: Equatable, Sendable {
    public var selection: ThemeSelection

    public init(selection: ThemeSelection) {
        self.selection = selection
    }

    public static let fallback = VisionTheme(selection: ThemeSelection(appearance: .light))

    public var palette: ThemePalette { selection.palette }
    public var isDark: Bool { selection.appearance == .dark }
    public var colorScheme: ColorScheme { isDark ? .dark : .light }

    public var background: Color { Color(token: palette.background) }
    public var foreground: Color { Color(token: palette.foreground) }
    /// `text-label-secondary`.
    public var secondaryLabel: Color { Color(token: palette.foreground, opacity: palette.labelSecondaryAlpha) }
    /// `text-label-tertiary`.
    public var tertiaryLabel: Color { Color(token: palette.foreground, opacity: palette.labelTertiaryAlpha) }
    public var card: Color { Color(token: palette.card) }
    public var border: Color { Color(token: palette.border) }
    public var primary: Color { Color(token: palette.primary) }
    public var destructive: Color { Color(token: palette.destructive) }
    public var success: Color { Color(token: palette.success) }
    public var warning: Color { Color(token: palette.warning) }
    public var info: Color { Color(token: palette.info) }
    public var muted: Color { Color(token: palette.muted) }
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
