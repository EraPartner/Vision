import Foundation

/// Money text for amounts whose currency came from a market data provider as free text (for example a
/// quote in `GBp`). A code that is not three letters has no currency formatting, so the amount is shown
/// with the provider's text after it.
public enum ResearchMoney {
    public static func code(_ text: String) -> CurrencyCode? { CurrencyCode(rawValue: text.uppercased()) }

    public static func text(_ value: Decimal, currency: String, locale: Locale, fractionDigits: Int) -> String {
        guard let code = code(currency) else {
            return VisionFormat.decimal(value, fractionDigits: fractionDigits, locale: locale) + " " + currency
        }
        return VisionFormat.currency(value, code: code, locale: locale, fractionDigits: fractionDigits)
    }
}
