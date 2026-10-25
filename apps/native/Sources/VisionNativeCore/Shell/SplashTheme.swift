import Foundation

/// `SplashThemeColors`: the active theme's HSL component strings ("158 64% 52%").
public struct SplashTheme: Equatable, Sendable {
    public enum Mode: String, Sendable {
        case light
        case dark
    }

    public var mode: Mode?
    public var background: String
    public var foreground: String
    public var surface: String?
    public var text: String?

    public init(mode: Mode?, background: String, foreground: String, surface: String? = nil, text: String? = nil) {
        self.mode = mode
        self.background = background
        self.foreground = foreground
        self.surface = surface
        self.text = text
    }

    /// `isValidHslComponents`: digits, spaces, `%` and dots only, at most 32 characters.
    public static func isValidHSLComponents(_ value: String) -> Bool {
        value.count <= 32
            && value.range(
                of: #"^[0-9]{1,3}(\.[0-9]+)?\s+[0-9]{1,3}(\.[0-9]+)?%\s+[0-9]{1,3}(\.[0-9]+)?%\z"#,
                options: .regularExpression) != nil
    }

    /// `splashThemeArguments` and `readSplashTheme`: `nil` unless every field is valid.
    /// `null` counts as absent, like `!= null`.
    public static func parse(_ value: JSONValue?) -> SplashTheme? {
        guard let value, value.objectValue != nil else { return nil }
        func optional(_ key: String) -> JSONValue? {
            guard let field = value[key], field != .null else { return nil }
            return field
        }
        guard let background = value["background"]?.stringValue, isValidHSLComponents(background),
            let foreground = value["foreground"]?.stringValue, isValidHSLComponents(foreground)
        else {
            return nil
        }
        var mode: Mode?
        if let rawMode = optional("mode") {
            guard let parsed = rawMode.stringValue.flatMap(Mode.init(rawValue:)) else { return nil }
            mode = parsed
        }
        var surface: String?
        if let rawSurface = optional("surface") {
            guard let text = rawSurface.stringValue, isValidHSLComponents(text) else { return nil }
            surface = text
        }
        var text: String?
        if let rawText = optional("text") {
            guard let value = rawText.stringValue, isValidHSLComponents(value) else { return nil }
            text = value
        }
        return SplashTheme(mode: mode, background: background, foreground: foreground, surface: surface, text: text)
    }

    /// The value stored under `splashTheme` in `settings.json`; absent fields are omitted.
    public var jsonValue: JSONValue {
        var fields: [String: JSONValue] = ["background": .string(background), "foreground": .string(foreground)]
        if let mode { fields["mode"] = .string(mode.rawValue) }
        if let surface { fields["surface"] = .string(surface) }
        if let text { fields["text"] = .string(text) }
        return .object(fields)
    }
}
