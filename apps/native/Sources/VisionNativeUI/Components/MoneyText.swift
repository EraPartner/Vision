import SwiftUI
import VisionNativeCore

/// A size of the display face (Fraunces, `type-large-title` to `type-title-3`) for money drawn in
/// it. SwiftUI's `textScale` does not resize a custom face, so the fraction (`text-[0.88em]`) and
/// the currency symbol (`text-[0.85em]`) take an explicit smaller size of the same face.
enum MoneyDisplaySize: Sendable {
    case largeTitle
    case title1
    case title2
    case title3

    private var style: TypeStyle {
        switch self {
        case .largeTitle: return DesignTokens.Typography.largeTitle
        case .title1: return DesignTokens.Typography.title1
        case .title2: return DesignTokens.Typography.title2
        case .title3: return DesignTokens.Typography.title3
        }
    }

    private var textStyle: Font.TextStyle {
        switch self {
        case .largeTitle: return .largeTitle
        case .title1: return .title
        case .title2: return .title2
        case .title3: return .title3
        }
    }

    /// The face at the ramp size times `scale`.
    func font(scale: CGFloat = 1) -> Font {
        VisionFonts.display(CGFloat(style.size) * scale, relativeTo: textStyle)
    }

    /// `Money`'s fraction: `text-[0.88em]`.
    static let fractionScale: CGFloat = 0.88
    /// `Money`'s currency symbol: `text-[0.85em]`.
    static let currencyScale: CGFloat = 0.85
}

/// `<Money amount currency signed />`: the amount in the app's number format and decimal
/// places, in tabular digits, coloured like the web's money cells (`text-gain` for zero and
/// above, the label colour below zero).
struct MoneyText: View {
    let amount: Decimal
    let currency: CurrencyCode
    let settings: NativeAppSettings
    var signed = true
    /// The web colours positive amounts `text-gain`; a total may opt out.
    var colored = true
    /// Hero figures roll their digits (`RollingNumber`), as `fmtParts` values do on the web.
    var rolling = false
    /// The display face the amount is drawn in, when it is one of the ramp's titles; the small
    /// fraction and symbol need it (see `MoneyDisplaySize`). Nil keeps the surrounding `.font`.
    var display: MoneyDisplaySize?
    @Environment(\.visionTheme) var theme

    var body: some View {
        let text = Self.text(amount, currency: currency, settings: settings, signed: signed)
        let separator = settings.numberFormat.locale.decimalSeparator?.first
        let color = colored && amount >= 0 ? theme.gain : theme.foreground
        Group {
            if rolling {
                RollingNumber(value: text, decimalSeparator: separator, display: display)
            } else {
                Self.styled(text, decimalSeparator: separator, color: color, display: display)
                    .monospacedDigit().lineLimit(1)
            }
        }
        .modifier(DisplayFontModifier(display: display))
        .foregroundStyle(color)
    }

    /// Money.tsx micro-typography in one `Text`, so it still truncates and reads as one
    /// value: the currency symbol is smaller and medium weight, the decimal separator and
    /// fraction smaller and dimmed.
    static func styled(
        _ text: String, decimalSeparator: Character?, color: Color, display: MoneyDisplaySize? = nil
    ) -> Text {
        let characters = Array(text)
        let roles = RollingNumber.roles(characters, decimalSeparator: decimalSeparator)
        var result = Text(verbatim: "")
        var start = 0
        while start < characters.count {
            var end = start + 1
            while end < characters.count, roles[end] == roles[start] { end += 1 }
            let run = Text(verbatim: String(characters[start..<end]))
            switch roles[start] {
            // Every run takes `color`: a caller that styled only the fraction showed "+27.000" in
            // the label colour and ",00 €" in gain gold.
            case .plain: result = result + run.foregroundStyle(color)
            case .currency:
                if let display {
                    result = result + run.font(display.font(scale: MoneyDisplaySize.currencyScale))
                        .foregroundStyle(color.opacity(0.85))
                } else {
                    result = result + run.fontWeight(.medium).textScale(.secondary).foregroundStyle(color.opacity(0.85))
                }
            case .minor:
                if let display {
                    result = result + run.font(display.font(scale: MoneyDisplaySize.fractionScale))
                        .foregroundStyle(color.opacity(0.75))
                } else {
                    result = result + run.textScale(.secondary).foregroundStyle(color.opacity(0.75))
                }
            }
            start = end
        }
        return result
    }

    /// The formatted amount, for labels and tests.
    static func text(_ amount: Decimal, currency: CurrencyCode, settings: NativeAppSettings, signed: Bool = true) -> String {
        MoneyTextCache.shared.text(
            amount, currency: currency, locale: settings.numberFormat.locale,
            fractionDigits: settings.showDecimalPlaces, signed: signed)
    }
}

/// Applies the display face of a `MoneyDisplaySize`, if any, to the amount.
struct DisplayFontModifier: ViewModifier {
    let display: MoneyDisplaySize?

    func body(content: Content) -> some View {
        if let display {
            content.font(display.font())
        } else {
            content
        }
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
