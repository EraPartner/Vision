import Foundation

/// A point in time decoded from the wire's ISO 8601 timestamp (OpenAPI `format: date-time`). It
/// wraps the `Date` and keeps the exact text it was read from, which is what it encodes back, so a
/// decode and re-encode never reformats a value (`2026-01-02T03:04:05.123456+00:00` stays so).
///
/// Accepted forms, which cover what the backend emits (`Date.toISOString()` for timestamptz
/// columns, `to_jsonb` and `::text` casts, zod `datetime({ offset: true })` validated input):
/// `YYYY-MM-DDTHH:mm:ss` with optional fractional seconds of any length, followed by a mandatory
/// zone: `Z`, `+HH:mm`, `+HHmm` or `+HH`. `T` may be a space, seconds may be absent. A timestamp
/// without a zone is rejected, since it names no instant.
///
/// Equality, hashing and ordering compare the instant, not the text.
public struct Instant: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    /// The instant.
    public let date: Date
    /// The text this value was read from, or the canonical form for one made from a `Date`.
    public let text: String
    /// The calendar day as written in the text, before any zone conversion: for the backend's
    /// `...Z` timestamps the UTC day. The web app's `formatDateStringWithAppSettings` shows this
    /// prefix, so date columns built from timestamps display the same day on both apps.
    public let writtenDay: CalendarDay

    /// An instant made in code, written as `YYYY-MM-DDTHH:mm:ss.SSSZ` (UTC), the form the backend
    /// emits for timestamps it creates.
    public init(date: Date) {
        let canonical = Self.canonical(of: date)
        self.date = date
        self.text = canonical.text
        self.writtenDay = canonical.day
    }

    /// Parses `text` (see the type's documentation); `nil` when it is not such a timestamp.
    public init?(_ text: String) {
        guard let parsed = Self.parse(text) else { return nil }
        self.date = parsed.date
        self.text = text
        self.writtenDay = parsed.day
    }

    /// Throws `InstantError.invalid` unless `text` is such a timestamp.
    public init(validating text: String) throws {
        guard let parsed = Instant(text) else { throw InstantError.invalid(text) }
        self = parsed
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let parsed = Instant(text) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "\"\(text)\" is not an ISO 8601 timestamp with a zone.")
        }
        self = parsed
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(text)
    }

    public var description: String {
        text
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.date == rhs.date
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(date)
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.date < rhs.date
    }

    // MARK: Parsing

    /// The instant of an ISO 8601 timestamp with a zone and the day as written, or `nil`.
    static func parse(_ text: String) -> (date: Date, day: CalendarDay)? {
        let bytes = Array(text.utf8)
        // YYYY-MM-DD, a separator, HH:mm and at least a one-character zone.
        guard bytes.count >= 17 else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                guard index < bytes.count else { return nil }
                let digit = Int(bytes[index]) - 0x30
                guard (0...9).contains(digit) else { return nil }
                value = value * 10 + digit
            }
            return value
        }
        guard let year = number(0..<4), bytes[4] == 0x2D, let month = number(5..<7), bytes[7] == 0x2D,
            let day = number(8..<10), CalendarDay.isValid(year: year, month: month, day: day)
        else { return nil }
        // `T`, `t` or a space.
        guard bytes[10] == 0x54 || bytes[10] == 0x74 || bytes[10] == 0x20 else { return nil }
        guard let hour = number(11..<13), bytes[13] == 0x3A, let minute = number(14..<16),
            hour <= 23, minute <= 59
        else { return nil }
        var index = 16
        var second = 0
        var fraction: TimeInterval = 0
        if index < bytes.count, bytes[index] == 0x3A {
            guard let value = number((index + 1)..<(index + 3)), value <= 60 else { return nil }
            second = value
            index += 3
            if index < bytes.count, bytes[index] == 0x2E || bytes[index] == 0x2C {
                index += 1
                var numerator: TimeInterval = 0
                var denominator: TimeInterval = 1
                var digits = 0
                while index < bytes.count, (0x30...0x39).contains(bytes[index]) {
                    // Nine digits are nanoseconds; further digits cannot change a `Date`.
                    if digits < 9 {
                        numerator = numerator * 10 + TimeInterval(bytes[index] - 0x30)
                        denominator *= 10
                    }
                    digits += 1
                    index += 1
                }
                guard digits > 0 else { return nil }
                fraction = numerator / denominator
            }
        }
        guard index < bytes.count else { return nil }
        var offsetSeconds = 0
        switch bytes[index] {
        case 0x5A, 0x7A:
            guard index + 1 == bytes.count else { return nil }
        case 0x2B, 0x2D:
            let sign = bytes[index] == 0x2D ? -1 : 1
            let rest = bytes.count - index - 1
            guard rest == 2 || rest == 4 || rest == 5, let hours = number((index + 1)..<(index + 3)) else {
                return nil
            }
            var minutes = 0
            if rest == 4 {
                guard let value = number((index + 3)..<(index + 5)) else { return nil }
                minutes = value
            } else if rest == 5 {
                guard bytes[index + 3] == 0x3A, let value = number((index + 4)..<(index + 6)) else { return nil }
                minutes = value
            }
            guard hours <= 23, minutes <= 59 else { return nil }
            offsetSeconds = sign * (hours * 3600 + minutes * 60)
        default:
            return nil
        }
        let wholeSeconds = daysFromCivil(year: year, month: month, day: day) * 86_400
            + hour * 3600 + minute * 60 + second - offsetSeconds
        return (
            Date(timeIntervalSince1970: TimeInterval(wholeSeconds) + fraction),
            CalendarDay(validYear: year, month: month, day: day)
        )
    }

    /// `YYYY-MM-DDTHH:mm:ss.SSSZ` in UTC, and its day. A date outside years 0000...9999 reads as
    /// the epoch.
    private static func canonical(of date: Date) -> (text: String, day: CalendarDay) {
        let total = date.timeIntervalSince1970
        guard total.isFinite, total >= -62_167_219_200, total < 253_402_300_800 else {
            return ("1970-01-01T00:00:00.000Z", .unixEpoch)
        }
        let whole = total.rounded(.down)
        var seconds = Int(whole)
        var millis = Int(((total - whole) * 1000).rounded())
        if millis >= 1000 {
            millis -= 1000
            seconds += 1
        }
        var days = seconds / 86_400
        var rest = seconds - days * 86_400
        if rest < 0 {
            rest += 86_400
            days -= 1
        }
        let civil = civilFromDays(days)
        let text = pad(civil.year, 4) + "-" + pad(civil.month, 2) + "-" + pad(civil.day, 2)
            + "T" + pad(rest / 3600, 2) + ":" + pad((rest % 3600) / 60, 2) + ":" + pad(rest % 60, 2)
            + "." + pad(millis, 3) + "Z"
        return (text, CalendarDay(validYear: civil.year, month: civil.month, day: civil.day))
    }

    /// Days from 1970-01-01 to a proleptic Gregorian date (Howard Hinnant's `days_from_civil`).
    private static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let shiftedYear = month <= 2 ? year - 1 : year
        let era = (shiftedYear >= 0 ? shiftedYear : shiftedYear - 399) / 400
        let yearOfEra = shiftedYear - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// The inverse of `daysFromCivil` (`civil_from_days`).
    private static func civilFromDays(_ days: Int) -> (year: Int, month: Int, day: Int) {
        let shifted = days + 719_468
        let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
        let dayOfEra = shifted - era * 146_097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthIndex = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthIndex + 2) / 5 + 1
        let month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9
        let year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        return (year, month, day)
    }

    private static func pad(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }
}

public enum InstantError: Error, Equatable, Sendable {
    case invalid(String)
}

extension APIQuery {
    /// A timestamp goes into a path or query as the text it was read from.
    public static func value(_ value: Instant) -> String {
        value.text
    }
}
