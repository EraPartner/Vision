import Foundation

/// How the report renderers read their data. The TypeScript renderers take the fetched data
/// as plain objects and lean on JavaScript's conversions; the data fetchers are not ported
/// yet, so the Swift renderers read the same JSON with the same conversions.
extension Optional where Wrapped == JSValue {
    /// `value?.[key]`: `nil` is `undefined`.
    subscript(key: String) -> JSValue? { self?.objectValue?[key] }
    /// `Number(value)`; `undefined` is NaN.
    var n: Double { self?.javaScriptNumber ?? .nan }
    /// `String(value)`.
    var s: String { self?.javaScriptString ?? "undefined" }
    /// The elements of an array; anything else has none.
    var items: [JSValue] {
        if case .array(let items)? = self { return items }
        return []
    }
    /// `value == null`.
    var isNullish: Bool { self == nil || self == .some(.null) }
    /// `Boolean(value)`.
    var isTruthy: Bool {
        switch self {
        case nil, .null?: return false
        case .bool(let flag)?: return flag
        case .number(let number)?: return !(number == 0 || number.isNaN)
        case .string(let text)?: return !text.isEmpty
        case .array?, .object?: return true
        }
    }
}

extension JSValue {
    subscript(key: String) -> JSValue? { objectValue?[key] }
    var n: Double { javaScriptNumber }
    var s: String { javaScriptString }
    var items: [JSValue] { Optional(self).items }
    var isTruthy: Bool { Optional(self).isTruthy }
}

/// The formatting helpers of `services/reports/sectionHelpers.ts`.
enum ReportFormat {
    /// `escapeHtml(String(value))`.
    static func escape(_ text: String) -> String {
        var out = ""
        out.reserveCapacity(text.utf8.count)
        for character in text.unicodeScalars {
            switch character {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&#039;"
            default: out.unicodeScalars.append(character)
            }
        }
        return out
    }

    /// `Array.prototype.sort(compare)`: stable, by the sign of `compare(a, b)`.
    static func sorted<T>(_ items: [T], _ compare: (T, T) -> Double) -> [T] {
        items.enumerated().sorted { a, b in
            let order = compare(a.element, b.element)
            if order < 0 { return true }
            if order > 0 { return false }
            return a.offset < b.offset
        }.map(\.element)
    }

    /// `Math.max(...values)`: NaN when any value is NaN.
    static func maximum(_ values: [Double]) -> Double {
        values.contains(where: \.isNaN) ? .nan : values.max() ?? -.infinity
    }

    /// `Intl.NumberFormat('en-US', { minimumFractionDigits, maximumFractionDigits })`: the
    /// shortest decimal text of the number, rounded half away from zero, grouped by thousands.
    static func number(_ value: Double, minimumFraction: Int, maximumFraction: Int) -> String {
        if value.isNaN { return "NaN" }
        if value.isInfinite { return value < 0 ? "-∞" : "∞" }
        guard let decimal = try? DecimalJS(value) else { return "NaN" }
        let rounded = decimal.toDecimalPlaces(maximumFraction, .halfUp)
        var text = rounded.abs.toFixed(maximumFraction, .halfUp)
        var fraction = ""
        if let point = text.firstIndex(of: ".") {
            fraction = String(text[text.index(after: point)...])
            text = String(text[..<point])
        }
        while fraction.count > minimumFraction, fraction.hasSuffix("0") { fraction.removeLast() }
        var grouped = ""
        for (offset, digit) in text.reversed().enumerated() {
            if offset > 0, offset % 3 == 0 { grouped.append(",") }
            grouped.append(digit)
        }
        let whole = String(grouped.reversed())
        let negative = value < 0 && !rounded.isZero
        return (negative ? "-" : "") + whole + (fraction.isEmpty ? "" : "." + fraction)
    }

    /// `number.toLocaleString()` in the `en-US` locale the reports are written in. (The
    /// TypeScript uses the machine's locale here.)
    static func count(_ value: Double) -> String { number(value, minimumFraction: 0, maximumFraction: 3) }

    /// `fmtCurrency(amount, currency)`: `EUR 1,234.56`, with a narrow space after a minus.
    static func currency(_ amount: Double, _ currency: String = "EUR") -> String {
        let sign = amount < 0 ? "-\u{202F}" : ""
        return "\(sign)\(currency)\u{00A0}\(number(Swift.abs(amount), minimumFraction: 2, maximumFraction: 2))"
    }

    /// `fmtPct(value, isRaw, digits)`.
    static func percent(_ value: Double, raw: Bool = false, digits: Int = 1) -> String {
        let percent = raw ? value : value * 100
        return "\(percent < 0 ? "-" : "+")\(JavaScriptNumber.toFixed(Swift.abs(percent), digits))%"
    }

    static let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    private static let longMonths = [
        "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November",
        "December",
    ]
    private static let weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

    /// The civil date of an instant at an offset from UTC.
    private static func civil(_ epochMs: Double, offsetSeconds: Int = 0) -> (year: Int, month: Int, day: Int, weekday: Int) {
        let days = Int(((epochMs / 1000 + Double(offsetSeconds)) / 86_400).rounded(.down))
        let date = XLSXWorkbook.civil(fromDays: days)
        // Day 0 (1 January 1970) was a Thursday.
        return (date.year, date.month, date.day, ((days % 7) + 11) % 7)
    }

    /// `fmtDate(text)`: `12 Jan 2025`, or a dash for no date. A `YYYY-MM-DD` text is that
    /// calendar day; any other ISO 8601 text is the day in `zone` (the machine's zone in the
    /// TypeScript). Text the language standard does not define is no date here.
    static func date(_ value: JSValue?, zone: TimeZone = .current) -> String {
        guard case .string(let text)? = value, !text.isEmpty, let time = XLSXWorkbook.isoTime(text), time.isFinite else { return "—" }
        let units = Array(text.utf8)
        let calendarDate =
            units.count == 10 && units[4] == 0x2D && units[7] == 0x2D
            && units.enumerated().allSatisfy { $0.offset == 4 || $0.offset == 7 || ($0.element >= 0x30 && $0.element <= 0x39) }
        let offset = calendarDate ? 0 : zone.secondsFromGMT(for: Date(timeIntervalSince1970: time / 1000))
        let day = civil(time, offsetSeconds: offset)
        // The en-GB month names of current ICU data: September is "Sept".
        return "\(day.day) \(day.month == 9 ? "Sept" : months[day.month - 1]) \(day.year)"
    }

    /// `toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })`.
    static func shortDateUTC(_ text: String) -> String {
        guard let time = XLSXWorkbook.isoTime(text), time.isFinite else { return "Invalid Date" }
        let day = civil(time)
        return "\(months[day.month - 1]) \(day.day), \(day.year)"
    }

    /// `toLocaleDateString('en-US', { [weekday: 'long',] day: 'numeric', month: 'long', year: 'numeric', timeZone })`.
    static func longDate(_ epochMs: Double, zone: AppTimeZone, weekday: Bool) -> String {
        let offset = zone.zone.secondsFromGMT(for: Date(timeIntervalSince1970: epochMs / 1000))
        let day = civil(epochMs, offsetSeconds: offset)
        return "\(weekday ? weekdays[day.weekday] + ", " : "")\(longMonths[day.month - 1]) \(day.day), \(day.year)"
    }

    /// `fmtMonthLabel(year, month)`: `Jan'25`.
    static func monthLabel(_ year: JSValue?, _ month: JSValue?) -> String {
        let index = (month.n - 1).truncatingRemainder(dividingBy: 12)
        // An index that is not 0...11 reads `undefined` from the table.
        let name = index >= 0 && index < 12 && index == index.rounded() ? months[Int(index)] : "undefined"
        return "\(name)'\(String(decoding: Array(year.s.utf16.dropFirst(2)), as: UTF16.self))"
    }

    /// `signClass(amount)`.
    static func sign(_ amount: Double) -> String { amount > 0 ? "pos" : amount < 0 ? "neg" : "neutral" }

    /// `toNumber(addAll(values))`: the decimal sum of the numbers' shortest texts.
    static func decimalSum(_ values: [Double]) -> Double {
        var total = DecimalJS.zero
        for value in values {
            guard let decimal = try? DecimalJS(value) else { return .nan }
            total = total.plus(decimal)
        }
        return total.toNumber
    }

    /// `toDecimal(b).comparedTo(a)` for a descending sort.
    static func descending(_ a: Double, _ b: Double) -> Double { b > a ? 1 : b < a ? -1 : 0 }

    private static let assetClasses: [String: (singular: String, plural: String)] = [
        "stock": ("Stock", "Stocks"), "etf": ("ETF", "ETFs"), "crypto": ("Crypto", "Crypto"), "metals": ("Metals", "Metals"),
        "savings": ("Savings", "Savings"), "bond": ("Bond", "Bonds"), "real_estate": ("Real Estate", "Real Estate"),
        "other": ("Other", "Other"),
    ]

    /// `assetClassLabel(assetClass, { plural })`.
    static func assetClassLabel(_ assetClass: String, plural: Bool = false) -> String {
        guard let labels = assetClasses[assetClass] else { return assetClass }
        return plural ? labels.plural : labels.singular
    }
}
