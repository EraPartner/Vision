import Foundation

public struct NativeSettingsAppearance: Equatable, Sendable {
    public let theme: ThemeSelection
    public let systemAccent: Bool
    public let effectiveVisualEffects: VisualEffects
    public let isLargeDisplay: Bool
    /// Missing/nonstring schedule inputs would throw in ThemeHydration. Retain the last appearance.
    public let invalidSchedule: Bool
}

/// Foundation-only counterparts of ThemeHydration.resolveTheme and lib/visualEffects.resolveEffectiveTier.
/// Doubles here represent geometry and clock components, never financial values.
public enum NativeSettingsAppearanceResolver {
    /// `isLargeDisplay` of lib/visualEffects (ADR-075, ADR-244): a built-in panel is never large,
    /// since the cap exists for external 4K/5K outputs. `isBuiltIn` is nil when unknown (React:
    /// outside the desktop app), where the pixel heuristic applies.
    public static func isLargeDisplay(physicalPixelCount: Double, isBuiltIn: Bool?) -> Bool {
        if isBuiltIn == true { return false }
        return physicalPixelCount > 6_000_000
    }
    public static func resolve(
        theme: TaxValue?, settings: NativeAppSettings, date: Date = Date(), calendar: Calendar = .current,
        systemIsDark: Bool, physicalPixelCount: Double, isBuiltInDisplay: Bool? = nil, sessionTierOverride: VisualEffects? = nil,
        previousAppearance: ThemeAppearance = .dark
    ) -> NativeSettingsAppearance {
        let mode = theme?["mode"]?.stringValue ?? "dark"
        let schedule =
            theme?["schedule"] == nil || theme?["schedule"] == .null
            ? NativeSettingsDefaults.theme["schedule"] : theme?["schedule"]
        let appearance: ThemeAppearance?
        switch mode {
        case "light": appearance = .light
        case "dark": appearance = .dark
        case "system": appearance = systemIsDark ? .dark : .light
        default: appearance = scheduledAppearance(schedule, date: date, calendar: calendar)
        }
        let variant = theme?["variant"]?.stringValue.flatMap(ThemeVariant.init(rawValue:)) ?? .default
        let large = isLargeDisplay(physicalPixelCount: physicalPixelCount, isBuiltIn: isBuiltInDisplay)
        let tier = settings.autoAdaptDisplay && large ? sessionTierOverride ?? .reduced : settings.visualEffects
        return .init(
            theme: .init(
                variant: variant, appearance: appearance ?? previousAppearance,
                colorblindGainLoss: settings.colorblindGainLoss),
            systemAccent: theme?["systemAccent"]?.boolValue ?? false,
            effectiveVisualEffects: tier, isLargeDisplay: large, invalidSchedule: appearance == nil)
    }
    private static func scheduledAppearance(_ schedule: TaxValue?, date: Date, calendar: Calendar) -> ThemeAppearance? {
        guard let lightFrom = schedule?["lightFrom"]?.stringValue, let darkFrom = schedule?["darkFrom"]?.stringValue
        else { return nil }
        let parts = calendar.dateComponents([.hour, .minute], from: date)
        let minutes = Double((parts.hour ?? 0) * 60 + (parts.minute ?? 0))
        let light = clockMinutes(lightFrom, defaultHour: 8)
        let dark = clockMinutes(darkFrom, defaultHour: 20)
        let isLight = light < dark ? minutes >= light && minutes < dark : minutes >= light || minutes < dark
        return isLight ? .light : .dark
    }
    private static func clockMinutes(_ text: String, defaultHour: Double) -> Double {
        let fields = text.split(separator: ":", omittingEmptySubsequences: false)
        let hours = fields.first.map { jsNumber(String($0)) } ?? defaultHour
        let minutes = fields.dropFirst().first.map { jsNumber(String($0)) } ?? 0
        return (hours.isFinite ? hours : defaultHour) * 60 + (minutes.isFinite ? minutes : 0)
    }
    /// Number(string), including empty/whitespace, decimal exponents and unsigned radix literals.
    /// Invalid or infinite components fall back before multiplication, as the source Number.isFinite checks do.
    private static func jsNumber(_ text: String) -> Double {
        let whitespace = CharacterSet(
            charactersIn:
                "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
        )
        let value = text.trimmingCharacters(in: whitespace)
        if value.isEmpty { return 0 }
        if value.hasPrefix("0x") || value.hasPrefix("0X") { return radixNumber(String(value.dropFirst(2)), radix: 16) }
        if value.hasPrefix("0b") || value.hasPrefix("0B") { return radixNumber(String(value.dropFirst(2)), radix: 2) }
        if value.hasPrefix("0o") || value.hasPrefix("0O") { return radixNumber(String(value.dropFirst(2)), radix: 8) }
        guard
            value.range(
                of: "\\A[+-]?(?:(?:[0-9]+(?:\\.[0-9]*)?|\\.[0-9]+)(?:[eE][+-]?[0-9]+)?|Infinity)\\z",
                options: .regularExpression) != nil
        else { return .nan }
        if value == "Infinity" || value == "+Infinity" { return .infinity }
        if value == "-Infinity" { return -.infinity }
        return Double(value) ?? .nan
    }
    private static func radixNumber(_ value: String, radix: Int) -> Double {
        guard !value.isEmpty else { return .nan }
        var number = 0.0
        for scalar in value.unicodeScalars {
            let digit: Int
            switch scalar.value {
            case 48...57: digit = Int(scalar.value - 48)
            case 65...70: digit = Int(scalar.value - 65 + 10)
            case 97...102: digit = Int(scalar.value - 97 + 10)
            default: return .nan
            }
            guard digit < radix else { return .nan }
            number = number * Double(radix) + Double(digit)
        }
        return number
    }
}
