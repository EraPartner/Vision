import Foundation

/// Chart axis formatting (apps/frontend/src/utils/currency.ts and lib/dateUtils.ts).
extension VisionFormat {
    /// `formatCurrencyAxisCompact`: the amount scaled to k / M / B / T with at most one fraction
    /// digit, the suffix placed right after the last digit so the locale keeps its own symbol
    /// order ("6,5k €" in `de_DE`, "$6.5k" in `en_US`). Amounts under one thousand keep no
    /// fraction digits.
    public static func currencyAxisCompact(_ value: Decimal, code: CurrencyCode, locale: Locale) -> String {
        guard !value.isNaN else { return "\(value)" }
        let magnitude = abs(value)
        let divisor: Decimal
        let suffix: String
        if magnitude >= 1_000_000_000_000 {
            divisor = 1_000_000_000_000
            suffix = "T"
        } else if magnitude >= 1_000_000_000 {
            divisor = 1_000_000_000
            suffix = "B"
        } else if magnitude >= 1_000_000 {
            divisor = 1_000_000
            suffix = "M"
        } else if magnitude >= 1_000 {
            divisor = 1_000
            suffix = "k"
        } else {
            divisor = 1
            suffix = ""
        }
        let style = Decimal.FormatStyle.Currency(code: code.rawValue, locale: locale)
            .precision(.fractionLength(0...(suffix.isEmpty ? 0 : 1)))
            .rounded(rule: .toNearestOrAwayFromZero)
        var text = (value / divisor).formatted(style)
        if !suffix.isEmpty, let lastDigit = text.lastIndex(where: { $0.isNumber }) {
            text.insert(contentsOf: suffix, at: text.index(after: lastDigit))
        }
        return text
    }

    /// `formatMonthYearWithAppSettings`: the month label that follows the app date format
    /// (`05/2026`, `2026-05`, `05.2026`, `05-2026`).
    public static func monthYear(year: Int, month: Int, format: AppDateFormat) -> String {
        let yyyy = zeroPadded(year, 4)
        let mm = zeroPadded(month, 2)
        switch format {
        case .dayMonthYearSlash, .monthDayYearSlash: return "\(mm)/\(yyyy)"
        case .isoDate: return "\(yyyy)-\(mm)"
        case .dayMonthYearDot: return "\(mm).\(yyyy)"
        case .dayMonthYearDash: return "\(mm)-\(yyyy)"
        }
    }

    private static func zeroPadded(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }
}
