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
    @Environment(\.visionTheme) var theme

    var body: some View {
        Text(Self.text(amount, currency: currency, settings: settings, signed: signed))
            .monospacedDigit()
            .lineLimit(1)
            .foregroundStyle(colored && amount >= 0 ? theme.gain : theme.foreground)
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
