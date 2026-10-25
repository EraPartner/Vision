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

    /// `formatPercent(value, { digits, locale })`: the number with `digits` fraction digits
    /// and grouping, then `%`.
    public static func percent(_ value: Decimal, digits: Int = 1, locale: Locale) -> String {
        guard (0...20).contains(digits), !value.isNaN else { return "\(value)%" }
        return decimal(value, fractionDigits: digits, locale: locale) + "%"
    }

    /// `String(number)` for a JSON number: no grouping, `.` as the separator, no trailing
    /// zeros (`18`, `12.5`).
    public static func plain(_ value: Decimal) -> String {
        if value.isNaN { return "NaN" }
        return NSDecimalNumber(decimal: value).stringValue
    }

    /// `count.toLocaleString(locale)`.
    public static func integer(_ value: Int, locale: Locale) -> String {
        value.formatted(IntegerFormatStyle<Int>(locale: locale))
    }

    /// `formatCurrency(amount, code, locale, fractionDigits, signed)`: fixed fraction digits;
    /// `signed` is `signDisplay: "exceptZero"` (a `+` before positive amounts, no sign on
    /// zero). A fraction-digit count outside 0...20 falls back to the bare number, as `Intl`
    /// throws.
    public static func currency(
        _ value: Decimal, code: CurrencyCode, locale: Locale, fractionDigits: Int, signed: Bool = false
    ) -> String {
        guard (0...20).contains(fractionDigits), !value.isNaN else { return "\(value)" }
        let style = Decimal.FormatStyle.Currency(code: code.rawValue, locale: locale)
            .precision(.fractionLength(fractionDigits))
            .rounded(rule: .toNearestOrAwayFromZero)
        if signed {
            return value.formatted(style.sign(strategy: .always(showZero: false)))
        }
        return value.formatted(style)
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
        let ymd =
            text.split(separator: "T", maxSplits: 1, omittingEmptySubsequences: false).first.map(String.init) ?? text
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
            return
                "\(appDate(instant, format: format, timeZone: timeZone)) \(time(instant, locale: locale, timeZone: timeZone))"
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
    public static func appDate(_ instant: Date, format: AppDateFormat, timeZone: TimeZone = .current) -> String {
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
        for formatter in isoTimestampParsers {
            if let date = formatter.date(from: text) { return date }
        }
        for formatter in localTimestampParsers.parsers(timeZone) {
            if let date = formatter.date(from: text) { return date }
        }
        return nil
    }

    /// Formatters are costly to create and table rows parse a timestamp per cell, so the
    /// parsers are built once. They are never mutated after creation, and Foundation's date
    /// formatters are thread-safe for parsing.
    // lint:allow nonisolated-unsafe immutable after creation, formatters are thread-safe for parsing
    private nonisolated(unsafe) static let isoTimestampParsers: [ISO8601DateFormatter] = {
        let variants: [ISO8601DateFormatter.Options] = [
            [.withInternetDateTime, .withFractionalSeconds], [.withInternetDateTime],
        ]
        return variants.map { options in
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = options
            return formatter
        }
    }()

    private static let localTimestampParsers = LocalTimestampParsers()

    /// The zone-less timestamp parsers, one set per time zone.
    // lint:allow unchecked-sendable cache guarded by an NSLock
    private final class LocalTimestampParsers: @unchecked Sendable {
        private let lock = NSLock()
        private var byZone: [TimeZone: [DateFormatter]] = [:]

        func parsers(_ timeZone: TimeZone) -> [DateFormatter] {
            lock.lock()
            defer { lock.unlock() }
            if let cached = byZone[timeZone] { return cached }
            let patterns = ["yyyy-MM-dd'T'HH:mm:ss.SSS", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd'T'HH:mm"]
            let parsers = patterns.map { pattern in
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "en_US_POSIX")
                formatter.timeZone = timeZone
                formatter.dateFormat = pattern
                return formatter
            }
            byZone[timeZone] = parsers
            return parsers
        }
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
