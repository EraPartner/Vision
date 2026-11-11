import Foundation

/// A calendar-day helper refused its input (`TypeError` and `RangeError` in the TypeScript).
struct CalendarDayError: Error, Equatable, Sendable {
    let message: String
}

/// JavaScript's `Date.UTC` and the calendar-day helpers of `lib/timezone.ts` and
/// `lib/dateFormat.ts` that involve no time zone. Instants are epoch milliseconds.
enum CalendarDays {
    static let millisecondsPerDay = 86_400_000
    /// The largest day number a JavaScript `Date` holds, either side of the epoch.
    static let dayLimit = 100_000_000
    /// A day or instant outside what a JavaScript `Date` holds (its `RangeError`).
    static let outOfRange = CalendarDayError(message: "Invalid Date")

    static func floorDivide(_ value: Int, _ divisor: Int) -> Int {
        let quotient = value / divisor
        return value % divisor < 0 ? quotient - 1 : quotient
    }

    /// `Date.UTC(year, monthIndex, day, hour, minute, second)`: fields past their range carry
    /// over, and a year from 0 to 99 means 1900 to 1999.
    static func utc(year: Int, monthIndex: Int, day: Int, hour: Int = 0, minute: Int = 0, second: Int = 0) -> Int {
        let fullYear = (0...99).contains(year) ? 1900 + year : year
        let carriedYear = fullYear + floorDivide(monthIndex, 12)
        let month = monthIndex - floorDivide(monthIndex, 12) * 12 + 1
        let days = ImportInterop.daysFromCivil(year: carriedYear, month: month, day: 1) + day - 1
        return (((days * 24 + hour) * 60 + minute) * 60 + second) * 1000
    }

    private static func digits(_ bytes: ArraySlice<UInt8>) -> Int? {
        var value = 0
        for byte in bytes {
            guard byte >= 0x30, byte <= 0x39 else { return nil }
            value = value * 10 + Int(byte - 0x30)
        }
        return value
    }

    /// `parseYmdParts(text)`: the three numbers of `YYYY-MM-DD`, not checked as a real date.
    static func parts(_ text: String) throws -> (year: Int, month: Int, day: Int) {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
            let year = digits(bytes[0..<4]), let month = digits(bytes[5..<7]), let day = digits(bytes[8..<10])
        else { throw CalendarDayError(message: "Expected YYYY-MM-DD, got: \(text)") }
        return (year, month, day)
    }

    /// `ymdToEpochDay(text)`: the day number of a strict, real `YYYY-MM-DD`.
    static func epochDay(_ text: String) throws -> Int {
        let (year, month, day) = try parts(text)
        guard ImportInterop.isCalendarDay(text) else { throw CalendarDayError(message: "Invalid calendar date: \(text)") }
        return ImportInterop.daysFromCivil(year: year, month: month, day: day)
    }

    /// `differenceInCalendarDaysYmd(from, to)`: positive when `to` is later.
    static func difference(from: String, to: String) throws -> Int {
        let end = try epochDay(to)
        return end - (try epochDay(from))
    }

    /// `new Date(dayNumber * 86_400_000).toISOString().slice(0, 10)`.
    static func isoPrefix(dayNumber: Int) throws -> String {
        guard dayNumber.magnitude <= UInt(dayLimit) else { throw outOfRange }
        return FormulaSemantics.CalendarDay(dayNumber: dayNumber).isoPrefix
    }

    /// `addDaysYmd(text, days)`.
    static func adding(_ days: Int, to text: String) throws -> String {
        try isoPrefix(dayNumber: try epochDay(text) + days)
    }

    private static func padded(_ value: Int, _ width: Int) -> String {
        let text = String(value)
        return String(repeating: "0", count: Swift.max(0, width - text.count)) + text
    }

    /// `firstOfMonthYmd(text, monthOffset)`: the first day of the month `monthOffset` months
    /// from the one `text` names.
    static func firstOfMonth(_ text: String, monthOffset: Int = 0) throws -> String {
        let (year, month, _) = try parts(text)
        let instant = utc(year: year, monthIndex: month - 1 + monthOffset, day: 1)
        let first = FormulaSemantics.CalendarDay(dayNumber: floorDivide(instant, millisecondsPerDay))
        return "\(padded(first.year, 4))-\(padded(first.month, 2))-01"
    }

    /// `epochMsToUtcYmd(ms)`.
    static func utcDay(epochMilliseconds: Int) throws -> String {
        guard epochMilliseconds.magnitude <= UInt(dayLimit * millisecondsPerDay) else { throw outOfRange }
        return try isoPrefix(dayNumber: floorDivide(epochMilliseconds, millisecondsPerDay))
    }
}

/// The zone business dates are computed in (`APP_TIMEZONE`, ADR-009): storage is UTC,
/// business math uses this zone.
struct AppTimeZone: Equatable, Sendable {
    static let defaultIdentifier = "Europe/Brussels"

    struct Invalid: Error, Equatable, Sendable {
        let identifier: String
        var message: String { "Invalid APP_TIMEZONE: \(identifier). Use an IANA zone name (e.g. Europe/Brussels)." }
    }

    /// Wall-clock fields in the zone (`AppTzParts`); `month` is 1 to 12.
    struct Parts: Equatable, Sendable {
        var year: Int
        var month: Int
        var day: Int
        var hour = 0
        var minute = 0
        var second = 0
    }

    let zone: TimeZone

    /// `resolveZone()`: the configured zone, or Europe/Brussels when none is configured.
    init(identifier: String? = nil) throws {
        let name = identifier.flatMap { $0.isEmpty ? nil : $0 } ?? Self.defaultIdentifier
        guard let zone = TimeZone(identifier: name) else { throw Invalid(identifier: name) }
        self.zone = zone
    }

    /// `toAppTz(date, zone)`: the wall clock in the zone. A year before 1 is the year of its
    /// era, as the `Intl` formatter the TypeScript reads prints it.
    func parts(atEpochMilliseconds instant: Int) -> Parts {
        let seconds = CalendarDays.floorDivide(instant, 1000)
        let local = seconds + zone.secondsFromGMT(for: Date(timeIntervalSince1970: TimeInterval(seconds)))
        let dayNumber = CalendarDays.floorDivide(local, 86_400)
        let secondOfDay = local - dayNumber * 86_400
        let day = FormulaSemantics.CalendarDay(dayNumber: dayNumber)
        return Parts(
            year: day.year < 1 ? 1 - day.year : day.year, month: day.month, day: day.day,
            hour: secondOfDay / 3600, minute: secondOfDay % 3600 / 60, second: secondOfDay % 60)
    }

    private static func utc(_ parts: Parts) -> Int {
        CalendarDays.utc(
            year: parts.year, monthIndex: parts.month - 1, day: parts.day, hour: parts.hour, minute: parts.minute,
            second: parts.second)
    }

    /// `toUtc(parts, zone)`: the instant of a wall clock in the zone, by the same two
    /// corrections the TypeScript makes, so a time a clock change skips or repeats resolves
    /// the same way.
    func epochMilliseconds(_ parts: Parts) -> Int {
        let target = Self.utc(parts)
        var instant = target
        for _ in 0..<2 {
            let difference = target - Self.utc(self.parts(atEpochMilliseconds: instant))
            if difference == 0 { break }
            instant += difference
        }
        return instant
    }

    /// `toAppDateString(date, zone)`: the calendar day in the zone.
    func day(atEpochMilliseconds instant: Int) -> String {
        let parts = parts(atEpochMilliseconds: instant)
        func padded(_ value: Int, _ width: Int) -> String {
            let text = String(value)
            return String(repeating: "0", count: Swift.max(0, width - text.count)) + text
        }
        return "\(padded(parts.year, 4))-\(padded(parts.month, 2))-\(padded(parts.day, 2))"
    }

    /// `todayAppDateString(zone)`: the one sanctioned source of "today" for business logic.
    func today(now: Date = Date()) -> String {
        day(atEpochMilliseconds: Int((now.timeIntervalSince1970 * 1000).rounded(.down)))
    }

    /// `appDateStringToUtc(text, zone)`: the instant the day starts in the zone.
    func startOfDay(_ text: String) throws -> Int {
        let (year, month, day) = try CalendarDays.parts(text)
        return epochMilliseconds(Parts(year: year, month: month, day: day))
    }
}
