import Foundation

/// A `Decimal` that is not a finite number. The formula engine can produce one (a payment
/// over a zero annuity factor) and then reports it instead of computing with it.
enum NonFiniteDecimal: Equatable, Sendable {
    case positiveInfinity
    case negativeInfinity
    case notANumber

    /// `toString()` and `toJSON()`.
    var text: String {
        switch self {
        case .positiveInfinity: return "Infinity"
        case .negativeInfinity: return "-Infinity"
        case .notANumber: return "NaN"
        }
    }

    /// `toNumber()`.
    var number: Double {
        switch self {
        case .positiveInfinity: return .infinity
        case .negativeInfinity: return -.infinity
        case .notANumber: return .nan
        }
    }
}

/// A value a formula expression evaluates to: a `Decimal` the engine computed, or a cell,
/// assumption or literal as JSON holds it.
enum FormulaValue: Equatable, Sendable {
    case decimal(DecimalJS)
    case nonFinite(NonFiniteDecimal)
    case json(JSValue)

    static let null = FormulaValue.json(.null)

    /// `value == null` for a value that is never `undefined`.
    var isNull: Bool { self == .null }

    /// `value instanceof Decimal`.
    var isDecimalInstance: Bool {
        switch self {
        case .decimal, .nonFinite: return true
        case .json: return false
        }
    }
}

/// JavaScript semantics the formula engine applies to untyped cells. `nil` is `undefined`.
enum FormulaSemantics {
    // MARK: Conversions

    /// `String(value)`.
    static func string(_ value: FormulaValue?) -> String {
        switch value {
        case nil: return "undefined"
        case .decimal(let decimal)?: return decimal.javaScriptString
        case .nonFinite(let special)?: return special.text
        case .json(let json)?: return json.javaScriptString
        }
    }

    /// `Number(comparable(value))`.
    static func number(_ value: FormulaValue?) -> Double {
        switch value {
        case nil: return .nan
        case .decimal(let decimal)?: return decimal.toNumber
        case .nonFinite(let special)?: return special.number
        case .json(let json)?: return json.javaScriptNumber
        }
    }

    /// `valueText(value)` of `services/valueText.ts`, for a value `decimal` refused.
    private static func valueText(_ value: FormulaValue) -> String {
        switch value {
        // `JSON.stringify` of a Decimal is its `toJSON()` string, quoted.
        case .decimal(let decimal): return JSValue.string(decimal.javaScriptString).jsonText
        case .nonFinite(let special): return JSValue.string(special.text).jsonText
        case .json(let json):
            switch json {
            case .array, .object: return json.jsonText
            case .null, .bool, .number, .string: return json.javaScriptString
            }
        }
    }

    /// `decimal(value)`: `nil` for a missing value (`null`, `undefined`, `""`), the number
    /// otherwise, or a `TYPE_ERROR` for anything `new Decimal` refuses or reads as non-finite.
    static func decimal(_ value: FormulaValue?) throws -> DecimalJS? {
        guard let value else { return nil }
        switch value {
        case .decimal(let decimal): return decimal
        case .json(.null): return nil
        case .json(.string(let text)):
            if text.isEmpty { return nil }
            if case .finite(let decimal) = DecimalJS.parse(text) { return decimal }
        case .json(.number(let number)):
            if let decimal = try? DecimalJS(number) { return decimal }
        case .nonFinite, .json(.bool), .json(.array), .json(.object): break
        }
        throw AnalysisFormulaError(.typeError, "Expected a decimal, received \(valueText(value))")
    }

    /// `Boolean(value)` for a JSON value; `nil` is `undefined`.
    static func truthy(_ value: JSValue?) -> Bool {
        switch value {
        case nil, .null?: return false
        case .bool(let flag)?: return flag
        case .number(let number)?: return number != 0 && !number.isNaN
        case .string(let text)?: return !text.isEmpty
        case .array?, .object?: return true
        }
    }

    /// `/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i`
    private static func looksNumeric(_ text: String) -> Bool {
        text.wholeMatch(of: /[+\-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+\-]?[0-9]+)?/) != nil
    }

    /// `condition(value)`: a number, or text that reads as one, is true unless it is zero;
    /// anything else by JavaScript truthiness.
    static func condition(_ value: FormulaValue) -> Bool {
        switch value {
        case .decimal(let decimal): return !decimal.isZero
        case .nonFinite: return true
        case .json(.number(let number)): return number != 0
        case .json(.string(let text)) where looksNumeric(text):
            // A numeric pattern always parses; an exponent out of range is an infinity or zero.
            if case .finite(let decimal) = DecimalJS.parse(text) { return !decimal.isZero }
            return true
        case .json(let json): return truthy(json)
        }
    }

    // MARK: Comparison

    /// Whether two strings hold the same code units (`===`); Swift's `==` also equates
    /// canonically equivalent text.
    static func sameText(_ left: String, _ right: String) -> Bool { left.utf8.elementsEqual(right.utf8) }

    /// `left === right` for JSON values (`nil` is `undefined`). Objects and arrays compare by
    /// identity in JavaScript, which parsed JSON never shares: `objectsEqual` says what two
    /// of them are here.
    static func strictlyEqual(_ left: JSValue?, _ right: JSValue?, objectsEqual: Bool = false) -> Bool {
        switch (left, right) {
        case (nil, nil), (.null?, .null?): return true
        case (.bool(let a)?, .bool(let b)?): return a == b
        case (.number(let a)?, .number(let b)?): return a == b
        case (.string(let a)?, .string(let b)?): return sameText(a, b)
        case (.array?, .array?), (.object?, .object?): return objectsEqual && left == right
        default: return false
        }
    }

    private enum Primitive {
        case text(String)
        case number(Double)

        /// `ToPrimitive(value, number)`.
        init(_ value: JSValue) {
            switch value {
            case .null: self = .number(0)
            case .bool(let flag): self = .number(flag ? 1 : 0)
            case .number(let number): self = .number(number)
            case .string(let text): self = .text(text)
            case .array, .object: self = .text(value.javaScriptString)
            }
        }

        var number: Double {
            switch self {
            case .text(let text): return JavaScriptNumber.fromString(text)
            case .number(let number): return number
            }
        }
    }

    /// `IsLessThan(left, right)`: `nil` when either side is `NaN`.
    private static func isLess(_ left: Primitive, _ right: Primitive) -> Bool? {
        if case .text(let a) = left, case .text(let b) = right {
            return a.utf16.lexicographicallyPrecedes(b.utf16)
        }
        let a = left.number
        let b = right.number
        return a.isNaN || b.isNaN ? nil : a < b
    }

    /// `compare(left, op, right)`: numeric when either side is a `Decimal` (an empty cell
    /// then gives no result), JavaScript's own operators otherwise.
    static func compare(_ left: FormulaValue, _ op: FormulaOperator, _ right: FormulaValue) throws -> Bool? {
        if left.isDecimalInstance || right.isDecimalInstance {
            guard let a = try decimal(left), let b = try decimal(right) else { return nil }
            let ordering = a.compared(to: b)
            switch op {
            case .equal: return ordering == 0
            case .notEqual: return ordering != 0
            case .less: return ordering < 0
            case .lessOrEqual: return ordering <= 0
            case .greater: return ordering > 0
            case .greaterOrEqual, .add, .subtract, .multiply, .divide: return ordering >= 0
            }
        }
        guard case .json(let a) = left, case .json(let b) = right else { return nil }
        switch op {
        case .equal: return strictlyEqual(a, b)
        case .notEqual: return !strictlyEqual(a, b)
        case .less: return isLess(Primitive(a), Primitive(b)) ?? false
        case .lessOrEqual: return isLess(Primitive(b), Primitive(a)).map { !$0 } ?? false
        case .greater: return isLess(Primitive(b), Primitive(a)) ?? false
        case .greaterOrEqual, .add, .subtract, .multiply, .divide:
            return isLess(Primitive(a), Primitive(b)).map { !$0 } ?? false
        }
    }

    /// The number of distinct values as a JavaScript `Set` counts them. Objects and arrays
    /// are each their own value.
    static func distinctCount(_ values: [JSValue?]) -> Int {
        var seen: [JSValue?] = []
        var count = 0
        for value in values {
            switch value {
            case .array?, .object?: count += 1
            default:
                if !seen.contains(where: { strictlyEqual($0, value) }) {
                    seen.append(value)
                    count += 1
                }
            }
        }
        return count
    }

    /// `typeof value === "string" && /^[A-Z]{3}$/.test(value)`.
    static func isCurrencyCode(_ value: JSValue?) -> Bool {
        guard case .string(let text)? = value else { return false }
        let units = Array(text.utf16)
        return units.count == 3 && units.allSatisfy { $0 >= 0x41 && $0 <= 0x5A }
    }

    // MARK: Dates

    /// What `Date.prototype.toISOString` throws for an invalid date in Bun (JavaScriptCore).
    static let invalidDateMessage = "Invalid Date"
    /// A `Date` holds at most 100,000,000 days either side of 1970-01-01.
    private static let maximumDateDays = 100_000_000.0

    struct CalendarDay: Equatable {
        var year: Int
        var month: Int
        var day: Int

        /// Days since 1970-01-01.
        var dayNumber: Int { ImportInterop.daysFromCivil(year: year, month: month, day: day) }

        /// The civil date of a day number (proleptic Gregorian).
        init(dayNumber: Int) {
            let shifted = dayNumber + 719_468
            let era = (shifted >= 0 ? shifted : shifted - 146_096) / 146_097
            let dayOfEra = shifted - era * 146_097
            let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36_524 - dayOfEra / 146_096) / 365
            let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
            let monthIndex = (5 * dayOfYear + 2) / 153
            day = dayOfYear - (153 * monthIndex + 2) / 5 + 1
            month = monthIndex < 10 ? monthIndex + 3 : monthIndex - 9
            year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0)
        }

        init(year: Int, month: Int, day: Int) {
            self.year = year
            self.month = month
            self.day = day
        }

        /// `toISOString().slice(0, 10)`: a year outside 0000–9999 is signed and six digits
        /// wide, so the slice cuts it off after the month.
        var isoPrefix: String {
            func padded(_ value: Int, _ width: Int) -> String {
                let digits = String(Swift.abs(value))
                return String(repeating: "0", count: Swift.max(0, width - digits.count)) + digits
            }
            if (0...9999).contains(year) { return "\(padded(year, 4))-\(padded(month, 2))-\(padded(day, 2))" }
            return "\(year < 0 ? "-" : "+")\(padded(year, 6))-\(padded(month, 2))"
        }
    }

    /// `date(value)`: a real calendar day written `YYYY-MM-DD`.
    static func date(_ value: FormulaValue?) throws -> CalendarDay {
        let raw = string(value)
        let bytes = Array(raw.utf8)
        func number(_ range: Range<Int>) -> Int? {
            var result = 0
            for byte in bytes[range] {
                guard byte >= 0x30, byte <= 0x39 else { return nil }
                result = result * 10 + Int(byte) - 0x30
            }
            return result
        }
        if bytes.count == 10, bytes[4] == UInt8(ascii: "-"), bytes[7] == UInt8(ascii: "-"),
            let year = number(0..<4), let month = number(5..<7), let day = number(8..<10)
        {
            let candidate = CalendarDay(year: year, month: month, day: day)
            if (1...12).contains(month), day >= 1, CalendarDay(dayNumber: candidate.dayNumber) == candidate {
                return candidate
            }
        }
        throw AnalysisFormulaError(.typeError, "Expected an ISO date, received \(raw)")
    }

    /// `result.setUTCDate(result.getUTCDate() + days); result.toISOString().slice(0, 10)`.
    static func adding(_ days: Double, to start: CalendarDay) throws -> String {
        let dayOfMonth = Double(start.day) + days
        guard dayOfMonth.isFinite else { throw FormulaFault(message: invalidDateMessage) }
        let firstOfMonth = CalendarDay(year: start.year, month: start.month, day: 1).dayNumber
        let dayNumber = Double(firstOfMonth) + dayOfMonth.rounded(.towardZero) - 1
        guard Swift.abs(dayNumber) <= maximumDateDays else { throw FormulaFault(message: invalidDateMessage) }
        return CalendarDay(dayNumber: Int(dayNumber)).isoPrefix
    }
}

/// An error the TypeScript engine reports as `EVALUATION_ERROR`: one thrown without a code,
/// by `decimal.js` or the JavaScript engine.
struct FormulaFault: Error, Equatable, Sendable {
    let message: String
}
