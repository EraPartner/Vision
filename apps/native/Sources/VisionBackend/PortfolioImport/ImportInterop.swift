import Foundation

/// JavaScript behaviours the import services depend on, spelled out so the Swift port
/// answers the same for the same stored values (ADR-270).
enum ImportInterop {
    // MARK: Calendar days

    /// `Date.parse(`${day}T00:00:00Z`) / 86400000` as Bun (JavaScriptCore) evaluates it: a
    /// four-digit year (or a signed six-digit one), a month 01–12 and a day 01–31 that rolls
    /// over into the next month ("2024-02-30" is 1 March). Anything else, and `nil`, is `NaN`.
    static func dayNumber(_ day: String?) -> Double {
        guard let day else { return .nan }
        var bytes = Array(day.utf8)[...]
        var sign = 1
        var yearDigits = 4
        if let first = bytes.first, first == UInt8(ascii: "+") || first == UInt8(ascii: "-") {
            sign = first == UInt8(ascii: "-") ? -1 : 1
            yearDigits = 6
            bytes = bytes.dropFirst()
        }
        guard bytes.count == yearDigits + 6 else { return .nan }
        let parts = Array(bytes)
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for byte in parts[range] {
                guard byte >= 0x30, byte <= 0x39 else { return nil }
                value = value * 10 + Int(byte - 0x30)
            }
            return value
        }
        guard parts[yearDigits] == UInt8(ascii: "-"), parts[yearDigits + 3] == UInt8(ascii: "-"),
            let year = number(0..<yearDigits), let month = number(yearDigits + 1..<yearDigits + 3),
            let dayOfMonth = number(yearDigits + 4..<yearDigits + 6),
            (1...12).contains(month), (1...31).contains(dayOfMonth)
        else { return .nan }
        return Double(daysFromCivil(year: sign * year, month: month, day: 1) + dayOfMonth - 1)
    }

    /// Days since 1970-01-01 in the proleptic Gregorian calendar.
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let adjustedYear = month <= 2 ? year - 1 : year
        let era = (adjustedYear >= 0 ? adjustedYear : adjustedYear - 399) / 400
        let yearOfEra = adjustedYear - era * 400
        let dayOfYear = (153 * (month > 2 ? month - 3 : month + 9) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146_097 + dayOfEra - 719_468
    }

    /// Whole days between two calendar days; `NaN` when either is not a day, so every
    /// comparison with it is false, as in JavaScript.
    static func dayDistance(_ left: String?, _ right: String?) -> Double {
        Swift.abs(dayNumber(left) - dayNumber(right))
    }

    /// A real calendar day in `YYYY-MM-DD` form (`new Date(...).toISOString()` round-trips).
    static func isCalendarDay(_ text: String) -> Bool {
        let bytes = Array(text.utf8)
        guard bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-") else { return false }
        func number(_ range: Range<Int>) -> Int? {
            var value = 0
            for byte in bytes[range] {
                guard byte >= 0x30, byte <= 0x39 else { return nil }
                value = value * 10 + Int(byte - 0x30)
            }
            return value
        }
        guard let year = number(0..<4), let month = number(5..<7), let day = number(8..<10),
            (1...12).contains(month), day >= 1
        else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        let lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
        return day <= lengths[month - 1]
    }

    // MARK: Text

    /// `cellText(value)` of `services/cellText.ts`: `String(value ?? "")`.
    static func cellText(_ value: JSValue?) -> String {
        guard let value, value != .null else { return "" }
        return value.javaScriptString
    }

    /// `value.replace(/\s/g, " ").trim()`: how the adapters read a header name.
    static func headerName(_ text: String) -> String {
        var spaced = String.UnicodeScalarView()
        for scalar in text.unicodeScalars { spaced.append(JavaScriptWhitespace.contains(scalar) ? " " : scalar) }
        return JavaScriptWhitespace.trim(String(spaced))
    }

    /// `normalizeIdentityText` of `services/importIdentity.ts`: NFKC, trimmed, whitespace
    /// runs collapsed to one space, upper case.
    static func normalizeIdentityText(_ text: String?) -> String {
        let trimmed = JavaScriptWhitespace.trim((text ?? "").precomposedStringWithCompatibilityMapping)
        var collapsed = String.UnicodeScalarView()
        var inRun = false
        for scalar in trimmed.unicodeScalars {
            if JavaScriptWhitespace.contains(scalar) {
                if !inRun { collapsed.append(" ") }
                inRun = true
            } else {
                collapsed.append(scalar)
                inRun = false
            }
        }
        return String(collapsed).uppercased()
    }

    static func isASCIIDigits(_ text: some StringProtocol) -> Bool {
        !text.isEmpty && text.utf8.allSatisfy { $0 >= 0x30 && $0 <= 0x39 }
    }

    // MARK: Numbers

    /// `toDecimal(value)` for a value read from stored JSON: a number, numeric text, or
    /// nullish (zero). `decimal.js` refuses anything else.
    static func decimal(_ value: JSValue?) throws -> DecimalJS {
        switch value {
        case nil, .null?: return .zero
        case .string(let text)?: return try DecimalJS.from(text)
        case .number(let number)?: return try DecimalJS(number)
        case .bool?, .array?, .object?: throw DecimalJSError(input: cellText(value))
        }
    }

    /// `Number.isInteger(value) && value > 0` as an `Int`.
    static func positiveInteger(_ value: Double) -> Int? {
        guard value.isFinite, value > 0, value.rounded(.towardZero) == value, let exact = Int(exactly: value) else {
            return nil
        }
        return exact
    }
}
