import Foundation

/// The web app's number and date formatting (apps/frontend/src/utils/currency.ts and
/// lib/dateUtils.ts) for native screens. JavaScript's `Intl` and Foundation both use ICU
/// data, so the separators, symbols and grouping match for the four number formats.
public enum VisionFormat {
    /// `value.toLocaleString(locale, { minimumFractionDigits: n, maximumFractionDigits: n })`:
    /// grouping on, half away from zero.
    public static func decimal(_ value: Decimal, fractionDigits: Int, locale: Locale) -> String {
        if value.isNaN { return "NaN" }
        let digits = max(0, min(20, fractionDigits))
        return value.formatted(
            Decimal.FormatStyle(locale: locale)
                .precision(.fractionLength(digits))
                .rounded(rule: .toNearestOrAwayFromZero))
    }

    /// `count.toLocaleString(locale)`.
    public static func integer(_ value: Int, locale: Locale) -> String {
        value.formatted(IntegerFormatStyle<Int>(locale: locale))
    }

    /// `formatCurrency(amount, code, locale, fractionDigits)`: fixed fraction digits; a
    /// fraction-digit count outside 0...20 falls back to the bare number, as `Intl` throws.
    public static func currency(_ value: Decimal, code: String, locale: Locale, fractionDigits: Int) -> String {
        guard (0...20).contains(fractionDigits), !value.isNaN else { return "\(value)" }
        return value.formatted(
            Decimal.FormatStyle.Currency(code: code, locale: locale)
                .precision(.fractionLength(fractionDigits))
                .rounded(rule: .toNearestOrAwayFromZero))
    }

    /// `1 / rate` for the "1 EUR =" column; `1 / 0` is `Infinity` in JavaScript.
    public static func inverse(_ rate: Decimal, fractionDigits: Int, locale: Locale) -> String {
        if rate.isZero { return "∞" }
        return decimal(1 / rate, fractionDigits: fractionDigits, locale: locale)
    }

    // MARK: Dates

    /// `formatDateWithAppSettings` for calendar parts.
    public static func appDate(year: Int, month: Int, day: Int, format: AppDateFormat) -> String {
        let yyyy = pad(year, 4)
        let mm = pad(month, 2)
        let dd = pad(day, 2)
        switch format {
        case .dayMonthYearSlash: return "\(dd)/\(mm)/\(yyyy)"
        case .monthDayYearSlash: return "\(mm)/\(dd)/\(yyyy)"
        case .isoDate: return "\(yyyy)-\(mm)-\(dd)"
        case .dayMonthYearDot: return "\(dd).\(mm).\(yyyy)"
        case .dayMonthYearDash: return "\(dd)-\(mm)-\(yyyy)"
        }
    }

    /// `formatDateStringWithAppSettings`: a `YYYY-MM-DD` prefix is a calendar day; a full
    /// timestamp is shown in the local zone; anything else is returned unchanged.
    public static func appDate(_ text: String, format: AppDateFormat, timeZone: TimeZone = .current) -> String {
        if text.isEmpty { return "" }
        let ymd = text.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? text
        if let parts = ymdParts(ymd) {
            return appDate(year: parts.year, month: parts.month, day: parts.day, format: format)
        }
        if let instant = parseTimestamp(text) {
            return appDate(instant, format: format, timeZone: timeZone)
        }
        return text
    }

    /// `formatDateTimeStringWithAppSettings`: a timestamp's local date and its
    /// `toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" })`.
    public static func appDateTime(
        _ text: String, format: AppDateFormat, locale: Locale, timeZone: TimeZone = .current
    ) -> String {
        if text.isEmpty { return "" }
        if text.contains("T"), let instant = parseTimestamp(text) {
            return "\(appDate(instant, format: format, timeZone: timeZone)) \(time(instant, locale: locale, timeZone: timeZone))"
        }
        let dateOnly = appDate(text, format: format, timeZone: timeZone)
        guard let parts = ymdParts(text) else { return dateOnly }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let midnight = calendar.date(from: DateComponents(year: parts.year, month: parts.month, day: parts.day))
        else { return dateOnly }
        return "\(dateOnly) \(time(midnight, locale: locale, timeZone: timeZone))"
    }

    /// The local calendar day of an instant, in the app date format.
    public static func appDate(_ instant: Date, format: AppDateFormat, timeZone: TimeZone) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: instant)
        return appDate(year: parts.year ?? 1970, month: parts.month ?? 1, day: parts.day ?? 1, format: format)
    }

    /// Two-digit hour and minute in the locale's hour cycle.
    public static func time(_ instant: Date, locale: Locale, timeZone: TimeZone) -> String {
        let style = Date.FormatStyle(locale: locale, calendar: Calendar(identifier: .gregorian), timeZone: timeZone)
            .hour(.twoDigits(amPM: .abbreviated))
            .minute(.twoDigits)
        return instant.formatted(style)
    }

    /// An ISO 8601 timestamp with or without fractional seconds and zone; without a zone it
    /// is local time, like `new Date("2026-01-02T03:04:05")`.
    public static func parseTimestamp(_ text: String, timeZone: TimeZone = .current) -> Date? {
        for options: ISO8601DateFormatter.Options in [
            [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime],
        ] {
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            if let date = formatter.date(from: text) { return date }
        }
        for pattern in ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.timeZone = timeZone
            formatter.dateFormat = pattern
            if let date = formatter.date(from: text) { return date }
        }
        return nil
    }

    private static func ymdParts(_ text: String) -> (year: Int, month: Int, day: Int)? {
        let pieces = text.split(separator: "-", omittingEmptySubsequences: false)
        guard pieces.count == 3, pieces[0].count == 4, pieces[1].count == 2, pieces[2].count == 2,
            pieces.allSatisfy({ $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }),
            let year = Int(pieces[0]), let month = Int(pieces[1]), let day = Int(pieces[2])
        else { return nil }
        return (year, month, day)
    }

    private static func pad(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }
}
