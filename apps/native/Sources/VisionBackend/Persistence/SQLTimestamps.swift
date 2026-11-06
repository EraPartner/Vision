import Foundation

/// Dates and timestamps with PostgreSQL semantics: a port of
/// `apps/node-backend/src/database/sqlite/timestamps.ts` (ADR-263, ADR-270).
///
/// Storage forms: DATE `YYYY-MM-DD`; TIMESTAMPTZ `YYYY-MM-DDTHH:MM:SS.ffffffZ` (UTC,
/// microseconds kept). The session time zone is the Mac's zone (`timeZone`), as for the
/// Bun backend. Month arithmetic clamps to the last day of the target month. A local
/// wall-clock time that a DST change skips or repeats resolves to the later candidate, as
/// PostgreSQL's DetermineTimeZoneOffset() does.
public struct SQLTimestamps: Sendable {
    /// An instant: epoch milliseconds plus the microseconds below them (0-999).
    public struct Instant: Sendable, Equatable {
        public var ms: Int64
        public var us: Int64
        public init(ms: Int64, us: Int64 = 0) {
            self.ms = ms
            self.us = us
        }
    }

    public struct CivilDate: Sendable, Equatable {
        public var year: Int64
        public var month: Int64
        public var day: Int64
        public init(year: Int64, month: Int64, day: Int64) {
            self.year = year
            self.month = month
            self.day = day
        }
    }

    /// PostgreSQL interval fields; JavaScript numbers in the original, so `Double`.
    public struct Interval: Sendable, Equatable {
        public var months: Double
        public var days: Double
        /// Microseconds of clock time.
        public var micros: Double
    }

    /// A date (`YYYY-MM-DD`) or a timestamp.
    public enum Moment: Sendable {
        case date(CivilDate)
        case instant(Instant)
    }

    public let timeZone: TimeZone

    public init(timeZone: TimeZone = .current) {
        self.timeZone = timeZone
    }

    static let dayMs: Int64 = 86_400_000
    static let microsPerDay: Double = 86_400_000_000

    static func timeError(_ message: String, _ code: String = "22007") -> SQLStateError {
        SQLStateError(message, code: code)
    }

    // MARK: Calendar arithmetic

    private static func floorDiv(_ a: Int64, _ b: Int64) -> Int64 {
        let q = a / b
        return (a % b != 0 && (a < 0) != (b < 0)) ? q - 1 : q
    }

    /// Days since 1970-01-01 of a proleptic Gregorian date (Hinnant's days_from_civil).
    static func daysFromCivil(_ year: Int64, _ month: Int64, _ day: Int64) -> Int64 {
        let y = month <= 2 ? year - 1 : year
        let era = floorDiv(y, 400)
        let yoe = y - era * 400
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }

    static func civilFromDays(_ days: Int64) -> CivilDate {
        let z = days + 719_468
        let era = floorDiv(z, 146_097)
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return CivilDate(year: yoe + era * 400 + (month <= 2 ? 1 : 0), month: month, day: day)
    }

    /// Epoch ms of a wall-clock time read as UTC; month and day may overflow, as in Date.UTC.
    static func wallMs(
        _ year: Int64, _ month: Int64, _ day: Int64, _ hour: Int64 = 0, _ minute: Int64 = 0, _ second: Int64 = 0
    ) -> Int64 {
        let zeroMonth = month - 1
        let y = year + floorDiv(zeroMonth, 12)
        let m = zeroMonth - floorDiv(zeroMonth, 12) * 12 + 1
        let days = daysFromCivil(y, m, 1) + day - 1
        return days * dayMs + hour * 3_600_000 + minute * 60_000 + second * 1000
    }

    static func civilOfWall(_ wall: Int64) -> CivilDate {
        civilFromDays(floorDiv(wall, dayMs))
    }

    /// Day of week of a wall time, 0 = Sunday (`getUTCDay`).
    static func weekday(_ wall: Int64) -> Int64 {
        let days = floorDiv(wall, dayMs)
        return ((days + 4) % 7 + 7) % 7
    }

    public static func daysInMonth(_ year: Int64, _ month: Int64) -> Int64 {
        switch month {
        case 2:
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
            return leap ? 29 : 28
        case 4, 6, 9, 11: return 30
        default: return 31
        }
    }

    static func validCivil(_ year: Int64, _ month: Int64, _ day: Int64) -> Bool {
        year >= 1 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month)
    }

    // MARK: Zones

    /// The session zone's UTC offset at an instant, in ms east of UTC.
    func offsetAt(_ ms: Int64) -> Int64 {
        let date = Date(timeIntervalSince1970: Double(ms) / 1000)
        return Int64(timeZone.secondsFromGMT(for: date)) * 1000
    }

    /// The instant of a session-zone wall-clock time (UTC-read ms); inside a skipped or
    /// repeated hour PostgreSQL takes the later candidate.
    func instantOfWall(_ wall: Int64) -> Int64 {
        let before = offsetAt(wall - Self.dayMs)
        let after = offsetAt(wall + Self.dayMs)
        let tBefore = wall - before
        if before == after {
            let own = offsetAt(tBefore)
            return own == before ? tBefore : wall - own
        }
        let tAfter = wall - after
        let beforeValid = offsetAt(tBefore) == before
        let afterValid = offsetAt(tAfter) == after
        if beforeValid && !afterValid { return tBefore }
        if afterValid && !beforeValid { return tAfter }
        return max(tBefore, tAfter)
    }

    func wallOfInstant(_ ms: Int64) -> Int64 { ms + offsetAt(ms) }

    func localMidnight(_ date: CivilDate) -> Int64 {
        instantOfWall(Self.wallMs(date.year, date.month, date.day))
    }

    /// The session-zone calendar date of an instant (`ts::date`).
    public func localDate(of instant: Instant) -> CivilDate {
        Self.civilOfWall(wallOfInstant(instant.ms))
    }

    // MARK: Text

    private static func pad(_ value: Int64, _ width: Int) -> String {
        let text = String(value)
        return text.count >= width ? text : String(repeating: "0", count: width - text.count) + text
    }

    public static func formatDate(_ date: CivilDate) -> String {
        "\(pad(date.year, 4))-\(pad(date.month, 2))-\(pad(date.day, 2))"
    }

    private static let dateExpression = try! NSRegularExpression(pattern: "^([0-9]{4})-([0-9]{2})-([0-9]{2})$")  // lint:allow force-try constant pattern
    private static let timestampExpression = try! NSRegularExpression(  // lint:allow force-try constant pattern
        pattern:
            #"^([0-9]{4})-([0-9]{2})-([0-9]{2})[T ]([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,9}))?)?\s*(Z|z|[+-][0-9]{2}(?::?[0-9]{2})?)?$"#
    )
    private static let writtenDateExpression = try! NSRegularExpression(pattern: #"^\s*([0-9]{4}-[0-9]{2}-[0-9]{2})[T ]"#)  // lint:allow force-try constant pattern

    /// The capture groups of a whole-string match (nil for an unmatched group).
    static func groups(_ expression: NSRegularExpression, _ text: String) -> [String?]? {
        let range = NSRange(text.startIndex..., in: text)
        guard let match = expression.firstMatch(in: text, range: range) else { return nil }
        return (0..<match.numberOfRanges).map { index in
            Range(match.range(at: index), in: text).map { String(text[$0]) }
        }
    }

    static func trimmed(_ text: String) -> String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    public static func parseDate(_ text: String) throws -> CivilDate {
        guard let m = groups(dateExpression, trimmed(text)), let year = Int64(m[1] ?? ""),
            let month = Int64(m[2] ?? ""), let day = Int64(m[3] ?? "")
        else { throw timeError("invalid input syntax for type date: \"\(text)\"") }
        if !validCivil(year, month, day) {
            throw timeError("date/time field value out of range: \"\(text)\"", "22008")
        }
        return CivilDate(year: year, month: month, day: day)
    }

    public static func isDateText(_ text: String) -> Bool { groups(dateExpression, text) != nil }

    /// A value is a timestamp (not a bare date) when it has a time part.
    public static func isTimestampText(_ text: String) -> Bool { groups(dateExpression, trimmed(text)) == nil }

    /// Canonical TIMESTAMPTZ text.
    public static func formatInstant(_ instant: Instant) throws -> String {
        guard abs(instant.ms) <= 8_640_000_000_000_000 else { throw timeError("timestamp out of range", "22008") }
        let civil = civilOfWall(instant.ms)
        guard civil.year >= 1, civil.year <= 9999 else { throw timeError("timestamp out of range", "22008") }
        let msOfDay = instant.ms - floorDiv(instant.ms, dayMs) * dayMs
        let hour = msOfDay / 3_600_000
        let minute = msOfDay / 60_000 % 60
        let second = msOfDay / 1000 % 60
        let millis = msOfDay % 1000
        return "\(formatDate(civil))T\(pad(hour, 2)):\(pad(minute, 2)):\(pad(second, 2)).\(pad(millis, 3))\(pad(instant.us, 3))Z"
    }

    /// C rint(): round half to even.
    static func rint(_ x: Double) -> Double { x.rounded(.toNearestOrEven) }

    static func addMicros(_ instant: Instant, _ micros: Int64) -> Instant {
        let total = instant.us + micros
        let carry = floorDiv(total, 1000)
        return Instant(ms: instant.ms + carry, us: total - carry * 1000)
    }

    /// With an offset or `Z` the instant is exact; without one the wall-clock time is read in
    /// the session zone, and a bare date means local midnight. Fractional seconds round to
    /// microseconds; `24:00:00` and a leap second `:60` roll over.
    public func parseInstant(_ text: String) throws -> Instant {
        let trimmedText = Self.trimmed(text)
        if Self.groups(Self.dateExpression, trimmedText) != nil {
            return Instant(ms: localMidnight(try Self.parseDate(trimmedText)))
        }
        guard let m = Self.groups(Self.timestampExpression, trimmedText) else {
            throw Self.timeError("invalid input syntax for type timestamp with time zone: \"\(text)\"")
        }
        func number(_ index: Int) -> Int64 { Int64(m[index] ?? "") ?? 0 }
        let year = number(1)
        let month = number(2)
        let day = number(3)
        let hour = number(4)
        let minute = number(5)
        let second = m[6] == nil ? 0 : number(6)
        let fsec = m[7].map { Int64(Self.rint((Double("0.\($0)") ?? 0) * 1_000_000)) } ?? 0
        let outOfRange =
            !Self.validCivil(year, month, day) || hour > 24 || minute > 59 || second > 60
            || (hour == 24 && (minute != 0 || second != 0 || fsec != 0))
        if outOfRange { throw Self.timeError("date/time field value out of range: \"\(text)\"", "22008") }
        let wall = Self.wallMs(year, month, day, hour, minute, second)
        let ms: Int64
        if let zone = m[8] {
            var offsetMinutes: Int64 = 0
            if zone != "Z" && zone != "z" {
                let sign: Int64 = zone.hasPrefix("-") ? -1 : 1
                let digits = zone.dropFirst().replacingOccurrences(of: ":", with: "")
                let hh = Int64(digits.prefix(2)) ?? 0
                let mm = digits.count > 2 ? Int64(digits.dropFirst(2).prefix(2)) ?? 0 : 0
                offsetMinutes = sign * (hh * 60 + mm)
            }
            ms = wall - offsetMinutes * 60_000
        } else {
            ms = instantOfWall(wall)
        }
        return Self.addMicros(Instant(ms: ms), fsec)
    }

    public func canonicalTimestamp(_ text: String) throws -> String {
        try Self.formatInstant(parseInstant(text))
    }

    /// PostgreSQL's date input for `x::date`: a date stays as is; canonical timestamp text
    /// gives its session-zone date; other text with a clock time gives the date it was
    /// written with (the whole text must still be a valid timestamp).
    public func dateInputText(_ text: String) throws -> String {
        if Self.isDateText(text) { return Self.formatDate(try Self.parseDate(text)) }
        let instant = try parseInstant(text)
        if try Self.formatInstant(instant) == text { return Self.formatDate(localDate(of: instant)) }
        if let written = Self.groups(Self.writtenDateExpression, text), let date = written[1] {
            return Self.formatDate(try Self.parseDate(date))
        }
        return Self.formatDate(localDate(of: instant))
    }

    // MARK: Date arithmetic

    public static func addMonths(_ date: CivilDate, _ months: Int64) throws -> CivilDate {
        let zeroBased = date.year * 12 + (date.month - 1) + months
        let year = floorDiv(zeroBased, 12)
        let month = zeroBased - year * 12 + 1
        if year < 1 || year > 9999 { throw timeError("date out of range", "22008") }
        return CivilDate(year: year, month: month, day: min(date.day, daysInMonth(year, month)))
    }

    public static func addDays(_ date: CivilDate, _ days: Int64) throws -> CivilDate {
        let out = civilOfWall(wallMs(date.year, date.month, date.day) + days * dayMs)
        if out.year < 1 || out.year > 9999 { throw timeError("date out of range", "22008") }
        return out
    }

    /// Whole days from b to a (`date - date`).
    public static func diffDays(_ a: CivilDate, _ b: CivilDate) -> Int64 {
        daysFromCivil(a.year, a.month, a.day) - daysFromCivil(b.year, b.month, b.day)
    }

    private static func wholeNumber(_ value: Double, _ what: String) throws -> Int64 {
        guard value.isFinite, value.rounded(.towardZero) == value else {
            throw timeError("\(what) count must be whole: \(SQLArguments.javaScriptText(value))", "22023")
        }
        return Int64(value)
    }

    // MARK: Intervals

    private static let unitAliases: [String: String] = [
        "us": "microsecond", "usec": "microsecond", "usecs": "microsecond", "useconds": "microsecond",
        "microsecon": "microsecond", "microsecond": "microsecond", "microseconds": "microsecond",
        "ms": "millisecond", "msec": "millisecond", "msecs": "millisecond", "mseconds": "millisecond",
        "millisecon": "millisecond", "millisecond": "millisecond", "milliseconds": "millisecond",
        "s": "second", "sec": "second", "secs": "second", "second": "second", "seconds": "second",
        "m": "minute", "min": "minute", "mins": "minute", "minute": "minute", "minutes": "minute",
        "h": "hour", "hr": "hour", "hrs": "hour", "hour": "hour", "hours": "hour",
        "d": "day", "day": "day", "days": "day",
        "w": "week", "week": "week", "weeks": "week",
        "mon": "month", "mons": "month", "month": "month", "months": "month",
        "y": "year", "yr": "year", "yrs": "year", "year": "year", "years": "year",
        "dec": "decade", "decs": "decade", "decade": "decade", "decades": "decade",
        "c": "century", "cent": "century", "century": "century", "centuries": "century",
        "mil": "millennium", "mils": "millennium", "millennium": "millennium", "millennia": "millennium",
    ]

    private static let microsPer: [String: Double] = [
        "second": 1_000_000, "minute": 60_000_000, "hour": 3_600_000_000, "day": 86_400_000_000,
    ]

    private enum IntervalField {
        case number(String)
        case time(String)
        case word(String)
    }

    private static func badInterval(_ text: String) -> SQLStateError {
        timeError("invalid input syntax for type interval: \"\(text)\"")
    }

    /// Splits interval text into fields as ParseDateTime() does.
    private static func intervalFields(_ text: String) throws -> [IntervalField] {
        var fields: [IntervalField] = []
        let s = Array(text.lowercased().unicodeScalars)
        var i = 0
        func at(_ k: Int) -> Unicode.Scalar? { k < s.count ? s[k] : nil }
        func isDigit(_ c: Unicode.Scalar?) -> Bool { c.map { $0 >= "0" && $0 <= "9" } ?? false }
        func isAlpha(_ c: Unicode.Scalar?) -> Bool { c.map { $0 >= "a" && $0 <= "z" } ?? false }
        func readNumber(_ start: Int, _ prefix: String) {
            var j = start
            while isDigit(at(j)) || at(j) == "." || at(j) == ":" { j += 1 }
            let body = prefix + String(String.UnicodeScalarView(s[start..<j]))
            fields.append(body.contains(":") ? .time(body) : .number(body))
            i = j
        }
        while i < s.count {
            let c = s[i]
            if c == " " || c == "\t" || c == "\n" || c == "\r" || c == "\u{0B}" || c == "\u{0C}" {
                i += 1
            } else if isDigit(c) || c == "." {
                readNumber(i, "")
            } else if c == "+" || c == "-" {
                var j = i + 1
                while at(j) == " " || at(j) == "\t" { j += 1 }
                if !isDigit(at(j)) && at(j) != "." { throw badInterval(text) }
                readNumber(j, String(c))
            } else if isAlpha(c) {
                var j = i
                while isAlpha(at(j)) { j += 1 }
                fields.append(.word(String(String.UnicodeScalarView(s[i..<j]))))
                i = j
            } else if c == "@" {
                i += 1
            } else {
                throw badInterval(text)
            }
        }
        return fields
    }

    private static let timeFieldExpression = try! NSRegularExpression(  // lint:allow force-try constant pattern
        pattern: #"^([+-]?)([0-9]+):([0-9]{1,2})(?::([0-9]{1,2})(\.[0-9]*)?)?$"#)
    private static let numberFieldExpression = try! NSRegularExpression(  // lint:allow force-try constant pattern
        pattern: #"^[+-]?([0-9]+\.?[0-9]*|\.[0-9]+)$"#)

    /// DecodeInterval() for the spellings Vision's SQL uses: fields right to left, a number
    /// takes the unit after it, a trailing bare number is seconds, fractions cascade down.
    public static func parseInterval(_ text: String) throws -> Interval {
        let fields = try intervalFields(text)
        if fields.isEmpty { throw badInterval(text) }
        var months = 0.0
        var days = 0.0
        var micros = 0.0
        var unit = "second"
        var ago = false
        var sawValue = false
        func fractDays(_ fraction: Double, _ perUnit: Double) {
            let extra = fraction * perUnit
            let whole = extra.rounded(.towardZero)
            days += whole
            micros += rint((extra - whole) * microsPerDay)
        }
        for field in fields.reversed() {
            switch field {
            case .word(let word):
                if word == "ago" {
                    if ago { throw badInterval(text) }
                    ago = true
                    continue
                }
                guard let alias = unitAliases[word] else { throw badInterval(text) }
                unit = alias
                continue
            case .time(let body):
                sawValue = true
                guard let m = groups(timeFieldExpression, body) else { throw badInterval(text) }
                let sign: Double = m[1] == "-" ? -1 : 1
                let minutes = Double(m[3] ?? "") ?? 0
                let seconds = m[4].flatMap { Double($0) } ?? 0
                if minutes > 59 || seconds > 59 {
                    throw timeError("interval field value out of range: \"\(text)\"", "22015")
                }
                let fraction: Double = {
                    guard let raw = m[5], raw != "." else { return 0 }
                    return rint((Double("0" + raw) ?? 0) * 1_000_000)
                }()
                let hours = Double(m[2] ?? "") ?? 0
                micros += sign * (hours * 3_600_000_000 + minutes * 60_000_000 + seconds * 1_000_000 + fraction)
                unit = "second"
                continue
            case .number(let body):
                sawValue = true
                guard groups(numberFieldExpression, body) != nil, let value = Double(body) else {
                    throw badInterval(text)
                }
                let whole = value.rounded(.towardZero)
                let fraction = value - whole
                switch unit {
                case "microsecond": micros += rint(value)
                case "millisecond": micros += rint(value * 1000)
                case "second", "minute", "hour":
                    let per = microsPer[unit] ?? 1
                    micros += whole * per + rint(fraction * per)
                case "day":
                    days += whole
                    micros += rint(fraction * microsPerDay)
                case "week":
                    days += whole * 7
                    fractDays(fraction, 7)
                case "month":
                    months += whole
                    fractDays(fraction, 30)
                case "year": months += whole * 12 + rint(fraction * 12)
                case "decade": months += whole * 120 + rint(fraction * 120)
                case "century": months += whole * 1200 + rint(fraction * 1200)
                case "millennium": months += whole * 12000 + rint(fraction * 12000)
                default: break
                }
                unit = "second"
            }
        }
        if !sawValue { throw badInterval(text) }
        let sign: Double = ago ? -1 : 1
        // Adding 0 turns a negated zero into 0.
        return Interval(months: sign * months + 0, days: sign * days + 0, micros: sign * micros + 0)
    }

    public static func negate(_ interval: Interval) -> Interval {
        Interval(months: -interval.months, days: -interval.days, micros: -interval.micros)
    }

    /// date + interval: Vision keeps a date, so clock time that is not whole days is refused.
    public static func addInterval(_ date: CivilDate, _ interval: Interval) throws -> CivilDate {
        if interval.micros.truncatingRemainder(dividingBy: microsPerDay) != 0 {
            throw timeError(
                "a date plus an interval with hours, minutes or seconds is a timestamp; convert the date first",
                "22023")
        }
        let shifted = try addMonths(date, try wholeNumber(interval.months, "month"))
        return try addDays(shifted, try wholeNumber(interval.days + interval.micros / microsPerDay, "day"))
    }

    /// timestamptz + interval (timestamptz_pl_interval): months on the local calendar, then
    /// days on the local calendar (keeping the wall-clock time), then clock time exactly.
    public func addInterval(_ instant: Instant, _ interval: Interval) throws -> Instant {
        var ms = instant.ms
        func step(_ shift: (CivilDate) throws -> CivilDate) rethrows {
            let wall = wallOfInstant(ms)
            let timeOfDay = wall - Self.floorDiv(wall, Self.dayMs) * Self.dayMs
            let civil = try shift(Self.civilOfWall(wall))
            ms = instantOfWall(Self.wallMs(civil.year, civil.month, civil.day) + timeOfDay)
        }
        if interval.months != 0 {
            let months = try Self.wholeNumber(interval.months, "month")
            try step { try Self.addMonths($0, months) }
        }
        if interval.days != 0 {
            let days = try Self.wholeNumber(interval.days, "day")
            try step { try Self.addDays($0, days) }
        }
        return Self.addMicros(Instant(ms: ms, us: instant.us), Int64(interval.micros))
    }

    // MARK: date_trunc

    private static let truncUnits: [String: String] = [
        "millennium": "millennium", "millennia": "millennium", "mil": "millennium", "mils": "millennium",
        "century": "century", "centuries": "century", "c": "century", "cent": "century",
        "decade": "decade", "decades": "decade", "dec": "decade", "decs": "decade",
        "year": "year", "years": "year", "y": "year", "yr": "year", "yrs": "year",
        "quarter": "quarter", "qtr": "quarter",
        "month": "month", "months": "month", "mon": "month", "mons": "month",
        "week": "week", "weeks": "week", "w": "week",
        "day": "day", "days": "day", "d": "day",
        "hour": "hour", "hours": "hour", "h": "hour", "hr": "hour", "hrs": "hour",
        "minute": "minute", "minutes": "minute", "m": "minute", "min": "minute", "mins": "minute",
        "second": "second", "seconds": "second", "s": "second", "sec": "second", "secs": "second",
        "milliseconds": "milliseconds", "millisecond": "milliseconds", "ms": "milliseconds",
        "msec": "milliseconds", "msecs": "milliseconds",
        "microseconds": "microseconds", "microsecond": "microseconds", "us": "microseconds",
        "usec": "microseconds", "usecs": "microseconds",
    ]

    private static func truncUnit(_ unit: String) throws -> String {
        guard let resolved = truncUnits[trimmed(unit).lowercased()] else {
            throw timeError("unit \"\(unit)\" not recognized for date_trunc", "22023")
        }
        return resolved
    }

    /// Monday of the ISO week containing a date.
    private static func isoWeekStart(_ date: CivilDate) throws -> CivilDate {
        let dow = weekday(wallMs(date.year, date.month, date.day))
        return try addDays(date, -((dow + 6) % 7))
    }

    private static func truncCivil(_ unit: String, _ date: CivilDate) throws -> CivilDate {
        switch unit {
        case "millennium": return CivilDate(year: floorDiv(date.year + 999, 1000) * 1000 - 999, month: 1, day: 1)
        case "century": return CivilDate(year: floorDiv(date.year + 99, 100) * 100 - 99, month: 1, day: 1)
        case "decade": return CivilDate(year: floorDiv(date.year, 10) * 10, month: 1, day: 1)
        case "year": return CivilDate(year: date.year, month: 1, day: 1)
        case "quarter": return CivilDate(year: date.year, month: floorDiv(date.month - 1, 3) * 3 + 1, day: 1)
        case "month": return CivilDate(year: date.year, month: date.month, day: 1)
        case "week": return try isoWeekStart(date)
        default: return date
        }
    }

    public static func truncDate(_ unit: String, _ date: CivilDate) throws -> CivilDate {
        let out = try truncCivil(try truncUnit(unit), date)
        if out.year < 1 { throw timeError("date out of range", "22008") }
        return out
    }

    /// Day and larger units land on local midnight; hour, minute and second keep the
    /// instant's own UTC offset (timestamptz_trunc).
    public func truncInstant(_ unit: String, _ instant: Instant) throws -> Instant {
        let resolved = try Self.truncUnit(unit)
        switch resolved {
        case "microseconds":
            return instant
        case "milliseconds":
            return Instant(ms: instant.ms)
        case "second", "minute", "hour":
            let offset = offsetAt(instant.ms)
            let size: Int64 = resolved == "second" ? 1000 : (resolved == "minute" ? 60_000 : 3_600_000)
            let wall = instant.ms + offset
            return Instant(ms: Self.floorDiv(wall, size) * size - offset)
        default:
            let civil = try Self.truncCivil(resolved, localDate(of: instant))
            if civil.year < 1 { throw Self.timeError("timestamp out of range", "22008") }
            return Instant(ms: localMidnight(civil))
        }
    }

    // MARK: date_part and to_char

    private static let partFields: [String: String] = [
        "year": "year", "years": "year", "y": "year", "yr": "year", "yrs": "year",
        "month": "month", "months": "month", "mon": "month", "mons": "month",
        "day": "day", "days": "day", "d": "day",
        "hour": "hour", "hours": "hour", "h": "hour", "hr": "hour", "hrs": "hour",
        "minute": "minute", "minutes": "minute", "m": "minute", "min": "minute", "mins": "minute",
        "second": "second", "seconds": "second", "s": "second", "sec": "second", "secs": "second",
        "milliseconds": "milliseconds", "millisecond": "milliseconds", "ms": "milliseconds",
        "msec": "milliseconds", "msecs": "milliseconds",
        "microseconds": "microseconds", "microsecond": "microseconds", "us": "microseconds",
        "usec": "microseconds", "usecs": "microseconds",
        "quarter": "quarter", "qtr": "quarter",
        "week": "week", "weeks": "week", "w": "week",
        "dow": "dow", "isodow": "isodow", "doy": "doy", "isoyear": "isoyear", "epoch": "epoch",
        "julian": "julian", "j": "julian",
        "decade": "decade", "decades": "decade", "dec": "decade", "decs": "decade",
        "century": "century", "centuries": "century", "c": "century", "cent": "century",
        "millennium": "millennium", "millennia": "millennium", "mil": "millennium", "mils": "millennium",
        "timezone": "timezone", "timezone_hour": "timezone_hour", "timezone_m": "timezone_minute",
        "timezone_minute": "timezone_minute",
    ]

    private static func isoWeek(_ date: CivilDate) throws -> (week: Int64, year: Int64) {
        let monday = try isoWeekStart(date)
        let thursday = try addDays(monday, 3)
        let start = wallMs(thursday.year, 1, 1)
        let week = floorDiv(wallMs(thursday.year, thursday.month, thursday.day) - start, 7 * dayMs) + 1
        return (week, thursday.year)
    }

    /// date_part(field, x) as float8. A date behaves as a timestamp without time zone at
    /// midnight; the time zone fields refuse it (0A000).
    public func datePart(_ field: String, _ value: Moment) throws -> Double {
        guard let f = Self.partFields[Self.trimmed(field).lowercased()] else {
            throw Self.timeError("unit \"\(field)\" not recognized for date_part", "22023")
        }
        let wall: Int64
        let us: Int64
        switch value {
        case .instant(let instant):
            wall = wallOfInstant(instant.ms)
            us = instant.us
        case .date(let date):
            wall = Self.wallMs(date.year, date.month, date.day)
            us = 0
        }
        let civil = Self.civilOfWall(wall)
        let msOfDay = wall - Self.floorDiv(wall, Self.dayMs) * Self.dayMs
        let hour = Double(msOfDay / 3_600_000)
        let minute = Double(msOfDay / 60_000 % 60)
        let second = Double(msOfDay / 1000 % 60)
        let fsec = Double(msOfDay % 1000 * 1000 + us)
        switch f {
        case "year": return Double(civil.year)
        case "quarter": return Double(Self.floorDiv(civil.month - 1, 3) + 1)
        case "month": return Double(civil.month)
        case "day": return Double(civil.day)
        case "dow": return Double(Self.weekday(wall))
        case "isodow":
            let dow = Self.weekday(wall)
            return Double(dow == 0 ? 7 : dow)
        case "doy": return Double(Self.diffDays(civil, CivilDate(year: civil.year, month: 1, day: 1)) + 1)
        case "week": return Double(try Self.isoWeek(civil).week)
        case "isoyear": return Double(try Self.isoWeek(civil).year)
        case "decade": return Double(Self.floorDiv(civil.year, 10))
        case "century": return Double(Self.floorDiv(civil.year + 99, 100))
        case "millennium": return Double(Self.floorDiv(civil.year + 999, 1000))
        case "hour": return hour
        case "minute": return minute
        case "second": return second + fsec / 1_000_000
        case "milliseconds": return second * 1000 + fsec / 1000
        case "microseconds": return second * 1_000_000 + fsec
        case "julian":
            let julian = Double(Self.daysFromCivil(civil.year, civil.month, civil.day) + 2_440_588)
            return julian + (hour * 3600 + minute * 60 + second + fsec / 1_000_000) / 86_400
        case "epoch":
            if case .instant(let instant) = value { return (Double(instant.ms) * 1000 + Double(instant.us)) / 1_000_000 }
            return Double(wall) / 1000
        default:
            guard case .instant(let instant) = value else {
                throw Self.timeError("unit \"\(field)\" not supported for type timestamp without time zone", "0A000")
            }
            let offsetSeconds = Double(offsetAt(instant.ms) / 1000)
            if f == "timezone" { return offsetSeconds }
            if f == "timezone_hour" { return (offsetSeconds / 3600).rounded(.towardZero) }
            return (offsetSeconds / 60).rounded(.towardZero).truncatingRemainder(dividingBy: 60)
        }
    }

    /// to_char for the patterns Vision uses; a timestamp formats its session-zone date.
    public func toChar(_ value: Moment, _ format: String) throws -> String {
        let civil: CivilDate
        switch value {
        case .date(let date): civil = date
        case .instant(let instant): civil = localDate(of: instant)
        }
        switch format {
        case "YYYY-MM-DD": return Self.formatDate(civil)
        case "YYYY-MM": return "\(Self.pad(civil.year, 4))-\(Self.pad(civil.month, 2))"
        case "YYYY": return Self.pad(civil.year, 4)
        case "MM": return Self.pad(civil.month, 2)
        case "DD": return Self.pad(civil.day, 2)
        default: throw Self.timeError("to_char format \"\(format)\" is not supported", "22023")
        }
    }

    /// A date text stays a date; anything else is read as a timestamp.
    public func moment(_ value: SQLValue, _ function: String) throws -> Moment? {
        switch value {
        case .null: return nil
        case .text(let text):
            return Self.isDateText(text) ? .date(try Self.parseDate(text)) : .instant(try parseInstant(text))
        default:
            throw SQLFunctionArgumentError("\(function): expected date or timestamp text")
        }
    }
}
