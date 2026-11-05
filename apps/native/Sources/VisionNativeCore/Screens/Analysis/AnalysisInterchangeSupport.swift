import Foundation

/// JSON with insertion-ordered objects and JavaScript number semantics. The TypeScript interchange
/// (packages/shared-utils/src/analysis/interchange.ts and workbook.ts) serializes `JSON.stringify`
/// text and iterates `Object.entries`, so output bytes depend on key order and on how a JS `number`
/// prints. `TaxValue` stores objects in a dictionary and numbers as `Decimal`, which loses both.
enum InterchangeJSON: Equatable, Sendable {
    struct Member: Equatable, Sendable {
        var key: String
        var value: InterchangeJSON
    }
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([InterchangeJSON])
    case object([Member])

    static func ordered(_ pairs: [(String, InterchangeJSON)]) -> InterchangeJSON {
        .object(pairs.map { Member(key: $0.0, value: $0.1) })
    }

    /// Keys the app emits in a fixed order. `TaxValue` cannot remember the order of the wire
    /// object, so objects converted from it use this order first and sorted keys for the rest.
    private static let keyPriority: [String: Int] = {
        let keys = [
            "kind", "id", "type", "label", "nullable", "unit", "offset", "limit", "hasMore", "reason",
            "returnedRows", "enforcedLimit", "name", "timezone", "workspace", "definitionId", "definitionVersion",
            "datasetIds", "sourceReferences", "assumptions", "formulas", "definitions", "values",
        ]
        return Dictionary(uniqueKeysWithValues: keys.enumerated().map { ($0.element, $0.offset) })
    }()

    init(tax value: TaxValue) {
        switch value {
        case .null: self = .null
        case .bool(let flag): self = .bool(flag)
        case .number(let number): self = .number(NSDecimalNumber(decimal: number).doubleValue)
        case .string(let text): self = .string(text)
        case .array(let items): self = .array(items.map { InterchangeJSON(tax: $0) })
        case .object(let fields):
            let keys = fields.keys.sorted { left, right in
                switch (Self.keyPriority[left], Self.keyPriority[right]) {
                case (let a?, let b?): return a < b
                case (.some, nil): return true
                case (nil, .some): return false
                case (nil, nil): return left < right
                }
            }
            self = .object(keys.map { Member(key: $0, value: InterchangeJSON(tax: fields[$0]!)) })
        }
    }

    subscript(key: String) -> InterchangeJSON? {
        guard case .object(let members) = self else { return nil }
        return members.first { $0.key == key }?.value
    }
    var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }
    var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }
    var doubleValue: Double? {
        if case .number(let value) = self { return value }
        return nil
    }
    var arrayValue: [InterchangeJSON]? {
        if case .array(let value) = self { return value }
        return nil
    }
    var members: [Member]? {
        if case .object(let value) = self { return value }
        return nil
    }
    var isNull: Bool { self == .null }
    /// JavaScript `typeof value === "object"` (null, arrays and objects).
    var isJSObject: Bool {
        switch self {
        case .null, .array, .object: true
        default: false
        }
    }

    /// `JSON.stringify(value)` for a defined value.
    func stringified() -> String {
        switch self {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return number.isFinite ? JSNumber.string(number) : "null"
        case .string(let text): return Self.quote(text)
        case .array(let items): return "[" + items.map { $0.stringified() }.joined(separator: ",") + "]"
        case .object(let members):
            return "{" + members.map { Self.quote($0.key) + ":" + $0.value.stringified() }.joined(separator: ",") + "}"
        }
    }
    /// `String(value)`.
    func jsString() -> String {
        switch self {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let number): return JSNumber.string(number)
        case .string(let text): return text
        case .array(let items): return items.map { $0.isNull ? "" : $0.jsString() }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    private static func quote(_ text: String) -> String {
        var out = "\""
        for scalar in text.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            default:
                if scalar.value < 0x20 {
                    out += "\\u" + String(format: "%04x", scalar.value)
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        return out + "\""
    }

    struct ParseError: Error, Equatable { let message: String }

    /// `JSON.parse`: duplicate keys keep the position of the first and the value of the last.
    static func parse(_ text: String) throws -> InterchangeJSON {
        var parser = Parser(bytes: Array(text.utf8))
        parser.skipSpace()
        let value = try parser.value()
        parser.skipSpace()
        guard parser.index == parser.bytes.count else { throw ParseError(message: "Unexpected JSON content") }
        return value
    }

    private struct Parser {
        let bytes: [UInt8]
        var index = 0
        init(bytes: [UInt8]) { self.bytes = bytes }
        mutating func skipSpace() {
            while index < bytes.count, [0x20, 0x09, 0x0A, 0x0D].contains(bytes[index]) { index += 1 }
        }
        func fail() -> ParseError { ParseError(message: "Invalid JSON at byte \(index)") }
        mutating func value() throws -> InterchangeJSON {
            guard index < bytes.count else { throw fail() }
            switch bytes[index] {
            case UInt8(ascii: "{"):
                index += 1
                var members: [Member] = []
                skipSpace()
                if index < bytes.count, bytes[index] == UInt8(ascii: "}") {
                    index += 1
                    return .object(members)
                }
                while true {
                    skipSpace()
                    guard index < bytes.count, bytes[index] == UInt8(ascii: "\"") else { throw fail() }
                    let key = try string()
                    skipSpace()
                    guard index < bytes.count, bytes[index] == UInt8(ascii: ":") else { throw fail() }
                    index += 1
                    skipSpace()
                    let item = try value()
                    if let existing = members.firstIndex(where: { $0.key == key }) {
                        members[existing].value = item
                    } else {
                        members.append(Member(key: key, value: item))
                    }
                    skipSpace()
                    guard index < bytes.count else { throw fail() }
                    if bytes[index] == UInt8(ascii: ",") {
                        index += 1
                        continue
                    }
                    if bytes[index] == UInt8(ascii: "}") {
                        index += 1
                        return .object(members)
                    }
                    throw fail()
                }
            case UInt8(ascii: "["):
                index += 1
                var items: [InterchangeJSON] = []
                skipSpace()
                if index < bytes.count, bytes[index] == UInt8(ascii: "]") {
                    index += 1
                    return .array(items)
                }
                while true {
                    skipSpace()
                    items.append(try value())
                    skipSpace()
                    guard index < bytes.count else { throw fail() }
                    if bytes[index] == UInt8(ascii: ",") {
                        index += 1
                        continue
                    }
                    if bytes[index] == UInt8(ascii: "]") {
                        index += 1
                        return .array(items)
                    }
                    throw fail()
                }
            case UInt8(ascii: "\""):
                return .string(try string())
            case UInt8(ascii: "t"): try literal("true"); return .bool(true)
            case UInt8(ascii: "f"): try literal("false"); return .bool(false)
            case UInt8(ascii: "n"): try literal("null"); return .null
            default: return try number()
            }
        }
        mutating func literal(_ word: String) throws {
            let expected = Array(word.utf8)
            guard index + expected.count <= bytes.count, Array(bytes[index..<index + expected.count]) == expected
            else { throw fail() }
            index += expected.count
        }
        mutating func number() throws -> InterchangeJSON {
            let start = index
            func digits(_ parser: inout Parser) -> Int {
                var count = 0
                while parser.index < parser.bytes.count, (0x30...0x39).contains(parser.bytes[parser.index]) {
                    parser.index += 1
                    count += 1
                }
                return count
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: "-") { index += 1 }
            guard index < bytes.count else { throw fail() }
            if bytes[index] == UInt8(ascii: "0") {
                index += 1
            } else if digits(&self) == 0 {
                throw fail()
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: ".") {
                index += 1
                if digits(&self) == 0 { throw fail() }
            }
            if index < bytes.count, bytes[index] == UInt8(ascii: "e") || bytes[index] == UInt8(ascii: "E") {
                index += 1
                if index < bytes.count, bytes[index] == UInt8(ascii: "+") || bytes[index] == UInt8(ascii: "-") {
                    index += 1
                }
                if digits(&self) == 0 { throw fail() }
            }
            guard let number = Double(String(decoding: bytes[start..<index], as: UTF8.self)) else { throw fail() }
            return .number(number)
        }
        mutating func string() throws -> String {
            index += 1
            var units: [UInt16] = []
            var run: [UInt8] = []
            func flush(_ run: inout [UInt8], _ units: inout [UInt16]) {
                if !run.isEmpty {
                    units.append(contentsOf: Array(String(decoding: run, as: UTF8.self).utf16))
                    run.removeAll()
                }
            }
            while index < bytes.count {
                let byte = bytes[index]
                if byte == UInt8(ascii: "\"") {
                    index += 1
                    flush(&run, &units)
                    return String(decoding: units, as: UTF16.self)
                }
                if byte < 0x20 { throw fail() }
                if byte == UInt8(ascii: "\\") {
                    flush(&run, &units)
                    index += 1
                    guard index < bytes.count else { throw fail() }
                    let escape = bytes[index]
                    index += 1
                    switch escape {
                    case UInt8(ascii: "\""): units.append(0x22)
                    case UInt8(ascii: "\\"): units.append(0x5C)
                    case UInt8(ascii: "/"): units.append(0x2F)
                    case UInt8(ascii: "b"): units.append(0x08)
                    case UInt8(ascii: "f"): units.append(0x0C)
                    case UInt8(ascii: "n"): units.append(0x0A)
                    case UInt8(ascii: "r"): units.append(0x0D)
                    case UInt8(ascii: "t"): units.append(0x09)
                    case UInt8(ascii: "u"):
                        guard index + 4 <= bytes.count,
                            let code = UInt16(String(decoding: bytes[index..<index + 4], as: UTF8.self), radix: 16)
                        else { throw fail() }
                        units.append(code)
                        index += 4
                    default: throw fail()
                    }
                    continue
                }
                run.append(byte)
                index += 1
            }
            throw fail()
        }
    }
}

/// JavaScript number conversions used by the interchange formats.
enum JSNumber {
    /// `String(number)` (ECMAScript Number::toString) built from Swift's shortest round-trip digits.
    static func string(_ value: Double) -> String {
        if value.isNaN { return "NaN" }
        if value == 0 { return "0" }
        if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
        if value < 0 { return "-" + string(-value) }
        var text = "\(value)"
        var exponent = 0
        if let marker = text.firstIndex(where: { $0 == "e" || $0 == "E" }) {
            exponent = Int(text[text.index(after: marker)...].replacingOccurrences(of: "+", with: "")) ?? 0
            text = String(text[..<marker])
        }
        let parts = text.split(separator: ".", omittingEmptySubsequences: false)
        let integerPart = String(parts[0])
        let fractionPart = parts.count > 1 ? String(parts[1]) : ""
        var digits = Array(integerPart + fractionPart)
        var point = integerPart.count + exponent
        while digits.count > 1, digits.first == "0" {
            digits.removeFirst()
            point -= 1
        }
        while digits.count > 1, digits.last == "0" { digits.removeLast() }
        let k = digits.count
        let n = point
        let digitText = String(digits)
        if k <= n && n <= 21 { return digitText + String(repeating: "0", count: n - k) }
        if 0 < n && n <= 21 {
            return String(digits[0..<n]) + "." + String(digits[n...])
        }
        if -6 < n && n <= 0 { return "0." + String(repeating: "0", count: -n) + digitText }
        let e = n - 1
        let sign = e < 0 ? "-" : "+"
        if k == 1 { return digitText + "e" + sign + String(abs(e)) }
        return String(digits[0]) + "." + String(digits[1...]) + "e" + sign + String(abs(e))
    }

    /// A `Decimal` carrying exactly the text `JSON.stringify` prints for the number.
    static func decimal(_ value: Double) -> Decimal? {
        guard value.isFinite else { return nil }
        return Decimal(string: string(value), locale: Locale(identifier: "en_US_POSIX"))
    }

    /// `Number(text)`.
    static func parse(_ raw: String) -> Double {
        var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        while text.hasPrefix("\u{FEFF}") { text.removeFirst() }
        while text.hasSuffix("\u{FEFF}") { text.removeLast() }
        if text.isEmpty { return 0 }
        switch text {
        case "Infinity", "+Infinity": return .infinity
        case "-Infinity": return -.infinity
        default: break
        }
        let lower = text.lowercased()
        for (prefix, radix) in [("0x", 16), ("0o", 8), ("0b", 2)] where lower.hasPrefix(prefix) {
            let body = lower.dropFirst(2)
            guard !body.isEmpty else { return .nan }
            var result = 0.0
            for character in body {
                guard let digit = character.hexDigitValue, digit < radix else { return .nan }
                result = result * Double(radix) + Double(digit)
            }
            return result
        }
        return decimalLiteral(text) ?? .nan
    }

    /// Parses `[+-]?(digits[.digits?]|.digits)([eE][+-]?digits)?` as a double, or nil.
    static func decimalLiteral(_ text: String) -> Double? {
        var scalars = Array(text.unicodeScalars)
        var sign = ""
        if let first = scalars.first, first == "+" || first == "-" {
            sign = first == "-" ? "-" : ""
            scalars.removeFirst()
        }
        func isDigit(_ scalar: Unicode.Scalar) -> Bool { scalar.value >= 0x30 && scalar.value <= 0x39 }
        var index = 0
        var integer = ""
        while index < scalars.count, isDigit(scalars[index]) {
            integer.unicodeScalars.append(scalars[index])
            index += 1
        }
        var fraction = ""
        if index < scalars.count, scalars[index] == "." {
            index += 1
            while index < scalars.count, isDigit(scalars[index]) {
                fraction.unicodeScalars.append(scalars[index])
                index += 1
            }
        }
        guard !integer.isEmpty || !fraction.isEmpty else { return nil }
        var exponent = ""
        if index < scalars.count, scalars[index] == "e" || scalars[index] == "E" {
            index += 1
            var exponentSign = ""
            if index < scalars.count, scalars[index] == "+" || scalars[index] == "-" {
                exponentSign = scalars[index] == "-" ? "-" : ""
                index += 1
            }
            var exponentDigits = ""
            while index < scalars.count, isDigit(scalars[index]) {
                exponentDigits.unicodeScalars.append(scalars[index])
                index += 1
            }
            guard !exponentDigits.isEmpty else { return nil }
            exponent = "e" + exponentSign + exponentDigits
        }
        guard index == scalars.count else { return nil }
        return Double(sign + (integer.isEmpty ? "0" : integer) + "." + (fraction.isEmpty ? "0" : fraction) + exponent)
    }

    /// `Number.isSafeInteger(Number(text))` for text already matching `-?(0|[1-9]\d*)`.
    static func isSafeIntegerText(_ text: String) -> Bool {
        guard let value = Double(text) else { return false }
        return abs(value) <= 9_007_199_254_740_991
    }
}

/// Calendar helpers on the proleptic Gregorian calendar, in days since 1970-01-01 UTC.
enum InterchangeCalendar {
    static func daysFromCivil(year: Int, month: Int, day: Int) -> Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400
        let mp = (month + 9) % 12
        let doy = (153 * mp + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy
        return era * 146_097 + doe - 719_468
    }
    static func civilFromDays(_ days: Int) -> (year: Int, month: Int, day: Int) {
        let z = days + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097
        let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)
        let mp = (5 * doy + 2) / 153
        let day = doy - (153 * mp + 2) / 5 + 1
        let month = mp < 10 ? mp + 3 : mp - 9
        return (month <= 2 ? y + 1 : y, month, day)
    }
    static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        default: return (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 ? 29 : 28
        }
    }
    /// `^\d{4}-\d{2}-\d{2}$` (ASCII digits) naming a real calendar day, the check
    /// `new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v` performs.
    static func realDate(_ text: String) -> (year: Int, month: Int, day: Int)? {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count == 10, scalars[4] == "-", scalars[7] == "-" else { return nil }
        var numbers: [Int] = []
        for range in [0..<4, 5..<7, 8..<10] {
            var value = 0
            for scalar in scalars[range] {
                guard scalar.value >= 0x30 && scalar.value <= 0x39 else { return nil }
                value = value * 10 + Int(scalar.value - 0x30)
            }
            numbers.append(value)
        }
        let (year, month, day) = (numbers[0], numbers[1], numbers[2])
        guard (1...12).contains(month), day >= 1, day <= daysInMonth(year: year, month: month) else { return nil }
        return (year, month, day)
    }
    /// `^\d{4}-\d{2}-\d{2}$` without the calendar check.
    static func looksLikeDate(_ text: String) -> Bool {
        let scalars = Array(text.unicodeScalars)
        guard scalars.count == 10 else { return false }
        for (index, scalar) in scalars.enumerated() {
            if index == 4 || index == 7 {
                if scalar != "-" { return false }
            } else if scalar.value < 0x30 || scalar.value > 0x39 {
                return false
            }
        }
        return true
    }
    /// `new Date(ms).toISOString().slice(0, 10)`; nil where JavaScript throws a RangeError.
    static func isoDatePrefix(milliseconds: Double) -> String? {
        guard milliseconds.isFinite, abs(milliseconds) <= 8.64e15 else { return nil }
        let days = Int((milliseconds.rounded(.towardZero) / 86_400_000).rounded(.down))
        let (year, month, day) = civilFromDays(days)
        let tail = String(format: "-%02d-%02d", month, day)
        if (0...9999).contains(year) { return String(format: "%04d", year) + tail }
        let sign = year < 0 ? "-" : "+"
        return String((sign + String(format: "%06d", abs(year)) + tail).prefix(10))
    }
}

enum InterchangeCRC32 {
    private static let table: [UInt32] = (0..<256).map { index -> UInt32 in
        var crc = UInt32(index)
        for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1) != 0 ? 0xEDB8_8320 : 0) }
        return crc
    }
    static func checksum(_ bytes: [UInt8]) -> UInt32 {
        var crc: UInt32 = 0xFFFF_FFFF
        for byte in bytes { crc = (crc >> 8) ^ table[Int((crc ^ UInt32(byte)) & 0xFF)] }
        return crc ^ 0xFFFF_FFFF
    }
}

/// `new TextDecoder().decode(bytes)`: UTF-8, a leading byte order mark removed, invalid bytes replaced.
func interchangeDecodeUTF8<S: Sequence>(_ bytes: S) -> String where S.Element == UInt8 {
    var array = Array(bytes)
    if array.count >= 3, array[0] == 0xEF, array[1] == 0xBB, array[2] == 0xBF { array.removeFirst(3) }
    return String(decoding: array, as: UTF8.self)
}
