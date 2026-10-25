import Foundation

/// A calendar day: year, month and day with no time and no time zone. It decodes from and encodes
/// to the wire's `YYYY-MM-DD` (OpenAPI `format: date` and the `^\d{4}-\d{2}-\d{2}$` patterns),
/// rejecting text that is not a real day of the proleptic Gregorian calendar (`2024-02-30`,
/// `2023-02-29`, month 13), so a bad value fails the decode like the web client's zod schema.
///
/// A day never converts through a time zone on its own: `2024-03-31` stays the 31st wherever the
/// device is. Conversion to and from `Date` needs an explicit `Calendar` (which carries the zone).
public struct CalendarDay: Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let year: Int
    public let month: Int
    public let day: Int

    /// `nil` unless the three parts are a real day (year 0...9999, as the wire's four digits).
    public init?(year: Int, month: Int, day: Int) {
        guard Self.isValid(year: year, month: month, day: day) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// For parts the caller has already checked with `isValid`.
    init(validYear year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// 1970-01-01, the Unix epoch's day.
    public static let unixEpoch = CalendarDay(validYear: 1970, month: 1, day: 1)

    /// Parses exactly `YYYY-MM-DD` (ASCII digits); `nil` for anything else, including an
    /// impossible day.
    public init?(_ text: String) {
        guard let parts = Self.parts(of: text) else { return nil }
        self.init(year: parts.year, month: parts.month, day: parts.day)
    }

    /// Throws `CalendarDayError.invalid` unless `text` is a real `YYYY-MM-DD` day.
    public init(validating text: String) throws {
        guard let parsed = CalendarDay(text) else { throw CalendarDayError.invalid(text) }
        self = parsed
    }

    /// The day `date` falls on in `calendar` (whose time zone decides where midnight is); `nil`
    /// when the calendar's year is outside 0...9999.
    public init?(_ date: Date, in calendar: Calendar) {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
        self.init(year: year, month: month, day: day)
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard let parsed = CalendarDay(text) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "\"\(text)\" is not a calendar day (YYYY-MM-DD).")
        }
        self = parsed
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(description)
    }

    /// Midnight at the start of this day in `calendar` (its time zone decides the instant). The
    /// calendar interprets the parts, so pass a Gregorian one; `nil` when it cannot form the day.
    public func date(in calendar: Calendar) -> Date? {
        calendar.date(from: DateComponents(year: year, month: month, day: day))
    }

    /// The wire text, `YYYY-MM-DD`.
    public var description: String {
        Self.pad(year, 4) + "-" + Self.pad(month, 2) + "-" + Self.pad(day, 2)
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        if lhs.year != rhs.year { return lhs.year < rhs.year }
        if lhs.month != rhs.month { return lhs.month < rhs.month }
        return lhs.day < rhs.day
    }

    /// Whether `year` is a Gregorian leap year.
    public static func isLeapYear(_ year: Int) -> Bool {
        year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
    }

    /// The number of days in `month` (1...12) of `year`; `0` for a month outside 1...12.
    public static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        case 2: return isLeapYear(year) ? 29 : 28
        default: return 0
        }
    }

    /// Whether the parts name a real day with a four-digit year.
    public static func isValid(year: Int, month: Int, day: Int) -> Bool {
        guard (0...9999).contains(year), (1...12).contains(month) else { return false }
        return day >= 1 && day <= daysInMonth(year: year, month: month)
    }

    /// The three numbers of exactly `YYYY-MM-DD`, not yet checked against the calendar.
    private static func parts(of text: String) -> (year: Int, month: Int, day: Int)? {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == 0x2D, bytes[7] == 0x2D else { return nil }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for index in range {
                let digit = Int(bytes[index]) - 0x30
                guard (0...9).contains(digit) else { return nil }
                value = value * 10 + digit
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10) else { return nil }
        return (year, month, day)
    }

    private static func pad(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }
}

public enum CalendarDayError: Error, Equatable, Sendable {
    case invalid(String)
}

extension APIQuery {
    /// A day goes into a path or query as its wire text.
    public static func value(_ value: CalendarDay) -> String {
        value.description
    }
}
