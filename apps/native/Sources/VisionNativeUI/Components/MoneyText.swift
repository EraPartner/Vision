import SwiftUI
import VisionNativeCore

/// `<Money amount currency signed />`: the amount in the app's number format and decimal
/// places, in tabular digits, coloured like the web's money cells (`text-gain` for zero and
/// above, the label colour below zero).
struct MoneyText: View {
    let amount: Decimal
    let currency: String
    let settings: NativeAppSettings
    var signed = true
    /// The web colours positive amounts `text-gain`; a total may opt out.
    var colored = true
    /// Hero figures roll their digits (`RollingNumber`), as `fmtParts` values do on the web.
    var rolling = false
    @Environment(\.visionTheme) var theme

    var body: some View {
        let text = Self.text(amount, currency: currency, settings: settings, signed: signed)
        let separator = settings.numberFormat.locale.decimalSeparator?.first
        let color = colored && amount >= 0 ? theme.gain : theme.foreground
        Group {
            if rolling {
                RollingNumber(value: text, decimalSeparator: separator)
            } else {
                Self.styled(text, decimalSeparator: separator, color: color).monospacedDigit().lineLimit(1)
            }
        }
        .foregroundStyle(color)
    }

    /// Money.tsx micro-typography in one `Text`, so it still truncates and reads as one
    /// value: the currency symbol is smaller and medium weight, the decimal separator and
    /// fraction smaller and dimmed.
    static func styled(_ text: String, decimalSeparator: Character?, color: Color) -> Text {
        let characters = Array(text)
        let roles = RollingNumber.roles(characters, decimalSeparator: decimalSeparator)
        var result = Text(verbatim: "")
        var start = 0
        while start < characters.count {
            var end = start + 1
            while end < characters.count, roles[end] == roles[start] { end += 1 }
            let run = Text(verbatim: String(characters[start..<end]))
            switch roles[start] {
            case .plain: result = result + run
            case .currency:
                result = result + run.fontWeight(.medium).textScale(.secondary).foregroundStyle(color.opacity(0.85))
            case .minor: result = result + run.textScale(.secondary).foregroundStyle(color.opacity(0.75))
            }
            start = end
        }
        return result
    }

    /// The formatted amount, for labels and tests.
    static func text(_ amount: Decimal, currency: String, settings: NativeAppSettings, signed: Bool = true) -> String {
        VisionFormat.currency(
            amount, code: currency.uppercased(), locale: settings.numberFormat.locale,
            fractionDigits: settings.showDecimalPlaces, signed: signed)
    }
}

/// The locale of the page's language, for weekday names (`appLanguageToLocale`).
enum LanguageLocale {
    static func locale(_ language: NativeLanguage) -> Locale {
        switch language {
        case .nl: return Locale(identifier: "nl_NL")
        case .en: return Locale(identifier: "en_US")
        }
    }

    /// `Intl.DateTimeFormat(locale, { weekday: "short" })`.
    static func shortWeekday(_ date: Date, language: NativeLanguage, calendar: Calendar) -> String {
        let style = Date.FormatStyle(locale: locale(language), calendar: calendar, timeZone: calendar.timeZone)
            .weekday(.abbreviated)
        return date.formatted(style)
    }
}
