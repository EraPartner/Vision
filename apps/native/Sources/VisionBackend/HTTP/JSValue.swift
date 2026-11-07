import Foundation
import VisionNativeCore

/// A JSON value as JavaScript holds it after `JSON.parse` (ADR-270): every number a double,
/// and object properties in JavaScript's order, so a handler sees what the TypeScript route
/// saw. `JSON.stringify` of it (`jsonText`) is byte-identical to JavaScript's, which matters
/// where the text is stored or compared (settings baselines are compared as jsonb text).
public indirect enum JSValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSValue])
    case object(JSObject)

    public static func int(_ value: Int) -> JSValue { .number(Double(value)) }
}

/// A plain object's own properties in JavaScript's order: array-index keys ascending, then
/// the other keys in insertion order. Setting an existing key keeps its position.
public struct JSObject: Equatable, Sendable {
    private var insertion: [String] = []
    private var storage: [String: JSValue] = [:]

    public init() {}

    public init(_ pairs: [(String, JSValue)]) {
        for (key, value) in pairs { self[key] = value }
    }

    public subscript(key: String) -> JSValue? {
        get { storage[key] }
        set {
            if let newValue {
                if storage.updateValue(newValue, forKey: key) == nil { insertion.append(key) }
            } else if storage.removeValue(forKey: key) != nil {
                insertion.removeAll { $0 == key }
            }
        }
    }

    public var isEmpty: Bool { storage.isEmpty }
    public var count: Int { storage.count }

    public func has(_ key: String) -> Bool { storage[key] != nil }

    /// `Object.keys`: array indexes (canonical integers below 2^32 − 1) ascending, then the rest.
    public var keys: [String] {
        let indexes = insertion.compactMap { key in Self.arrayIndex(key).map { (key, $0) } }
        guard !indexes.isEmpty else { return insertion }
        let rest = insertion.filter { Self.arrayIndex($0) == nil }
        return indexes.sorted { $0.1 < $1.1 }.map(\.0) + rest
    }

    /// `Object.entries`.
    public var entries: [(String, JSValue)] { keys.map { ($0, storage[$0] ?? .null) } }

    static func arrayIndex(_ key: String) -> UInt64? {
        guard let first = key.utf8.first, key.utf8.count <= 10, key.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else {
            return nil
        }
        if first == 48, key.utf8.count > 1 { return nil }
        guard let value = UInt64(key), value < 4_294_967_295 else { return nil }
        return value
    }

    public static func == (lhs: JSObject, rhs: JSObject) -> Bool {
        lhs.storage == rhs.storage && lhs.keys == rhs.keys
    }
}

extension JSValue {
    /// `typeof` refined the way zod names a received value: `null`, `array`, `NaN`.
    var zodTypeName: String {
        switch self {
        case .null: return "null"
        case .bool: return "boolean"
        case .number(let value):
            if value.isNaN { return "NaN" }
            if value.isInfinite { return value < 0 ? "-Infinity" : "Infinity" }
            return "number"
        case .string: return "string"
        case .array: return "array"
        case .object: return "object"
        }
    }

    var objectValue: JSObject? {
        if case .object(let object) = self { return object }
        return nil
    }

    var stringValue: String? {
        if case .string(let text) = self { return text }
        return nil
    }

    /// `Number(value)` (ToNumber).
    var javaScriptNumber: Double {
        switch self {
        case .null: return 0
        case .bool(let flag): return flag ? 1 : 0
        case .number(let value): return value
        case .string(let text): return JavaScriptNumber.fromString(text)
        case .array, .object: return JavaScriptNumber.fromString(javaScriptString)
        }
    }

    /// `String(value)` (ToString); `looseString` of `lib/looseString.ts` is the same for JSON.
    var javaScriptString: String {
        switch self {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .number(let value): return SQLArguments.javaScriptText(value)
        case .string(let text): return text
        case .array(let items):
            return items.map { item in item == .null ? "" : item.javaScriptString }.joined(separator: ",")
        case .object: return "[object Object]"
        }
    }

    /// `JSON.stringify(value)`.
    public var jsonText: String {
        var out = ""
        write(to: &out)
        return out
    }

    private func write(to out: inout String) {
        switch self {
        case .null: out += "null"
        case .bool(let flag): out += flag ? "true" : "false"
        case .number(let value): out += value.isFinite ? SQLArguments.javaScriptText(value) : "null"
        case .string(let text): JSValue.quote(text, into: &out)
        case .array(let items):
            out += "["
            for (index, item) in items.enumerated() {
                if index > 0 { out += "," }
                item.write(to: &out)
            }
            out += "]"
        case .object(let object):
            out += "{"
            for (index, (key, value)) in object.entries.enumerated() {
                if index > 0 { out += "," }
                JSValue.quote(key, into: &out)
                out += ":"
                value.write(to: &out)
            }
            out += "}"
        }
    }

    /// `QuoteJSONString`.
    static func quote(_ text: String, into out: inout String) {
        out += "\""
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
                    let hex = String(scalar.value, radix: 16)
                    out += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    out.unicodeScalars.append(scalar)
                }
            }
        }
        out += "\""
    }

    /// `JSON.parse(text)`; nil where JavaScript throws a SyntaxError. A lone surrogate escape
    /// becomes U+FFFD, which a Swift string cannot avoid.
    public static func parse(_ text: String) -> JSValue? {
        var parser = JSONTextParser(Array(text.utf8))
        return parser.document()
    }

    public static func parse(_ data: Data) -> JSValue? {
        var parser = JSONTextParser(Array(data))
        return parser.document()
    }
}

/// A strict JSON parser with `JSON.parse`'s results.
private struct JSONTextParser {
    let bytes: [UInt8]
    var index = 0

    init(_ bytes: [UInt8]) { self.bytes = bytes }

    var current: UInt8? { index < bytes.count ? bytes[index] : nil }

    mutating func skipSpace() {
        while let byte = current, byte == 0x20 || byte == 0x09 || byte == 0x0A || byte == 0x0D { index += 1 }
    }

    mutating func document() -> JSValue? {
        // A UTF-8 byte order mark is not JSON whitespace; body-parser has already decoded it away.
        skipSpace()
        guard let value = value(depth: 0) else { return nil }
        skipSpace()
        return index == bytes.count ? value : nil
    }

    mutating func value(depth: Int) -> JSValue? {
        guard depth < 4096 else { return nil }
        skipSpace()
        guard let byte = current else { return nil }
        switch byte {
        case UInt8(ascii: "{"): return object(depth: depth)
        case UInt8(ascii: "["): return array(depth: depth)
        case UInt8(ascii: "\""): return string().map(JSValue.string)
        case UInt8(ascii: "t"): return literal("true", .bool(true))
        case UInt8(ascii: "f"): return literal("false", .bool(false))
        case UInt8(ascii: "n"): return literal("null", .null)
        default: return number()
        }
    }

    mutating func literal(_ word: String, _ result: JSValue) -> JSValue? {
        let utf8 = Array(word.utf8)
        guard index + utf8.count <= bytes.count, Array(bytes[index..<(index + utf8.count)]) == utf8 else { return nil }
        index += utf8.count
        return result
    }

    mutating func number() -> JSValue? {
        let start = index
        func digits() -> Int {
            var count = 0
            while let byte = current, byte >= 48, byte <= 57 {
                index += 1
                count += 1
            }
            return count
        }
        if current == UInt8(ascii: "-") { index += 1 }
        guard let first = current, first >= 48, first <= 57 else { return nil }
        if first == 48 {
            index += 1
        } else {
            _ = digits()
        }
        if current == UInt8(ascii: ".") {
            index += 1
            guard digits() > 0 else { return nil }
        }
        if current == UInt8(ascii: "e") || current == UInt8(ascii: "E") {
            index += 1
            if current == UInt8(ascii: "+") || current == UInt8(ascii: "-") { index += 1 }
            guard digits() > 0 else { return nil }
        }
        let text = String(decoding: bytes[start..<index], as: UTF8.self)
        guard let value = Double(text) else { return nil }
        return .number(value)
    }

    mutating func hex4() -> UInt32? {
        guard index + 4 <= bytes.count else { return nil }
        var value: UInt32 = 0
        for _ in 0..<4 {
            let byte = bytes[index]
            let digit: UInt32
            switch byte {
            case 48...57: digit = UInt32(byte - 48)
            case 65...70: digit = UInt32(byte - 55)
            case 97...102: digit = UInt32(byte - 87)
            default: return nil
            }
            value = value * 16 + digit
            index += 1
        }
        return value
    }

    mutating func string() -> String? {
        index += 1
        var out = String.UnicodeScalarView()
        var runStart = index
        func flushRun(_ end: Int, into out: inout String.UnicodeScalarView) -> Bool {
            guard runStart < end else { return true }
            guard let run = String(validating: bytes[runStart..<end], as: UTF8.self) else { return false }
            out.append(contentsOf: run.unicodeScalars)
            return true
        }
        while let byte = current {
            if byte == UInt8(ascii: "\"") {
                guard flushRun(index, into: &out) else { return nil }
                index += 1
                return String(out)
            }
            if byte < 0x20 { return nil }
            if byte != UInt8(ascii: "\\") {
                index += 1
                continue
            }
            guard flushRun(index, into: &out) else { return nil }
            index += 1
            guard let escape = current else { return nil }
            index += 1
            switch escape {
            case UInt8(ascii: "\""): out.append("\"")
            case UInt8(ascii: "\\"): out.append("\\")
            case UInt8(ascii: "/"): out.append("/")
            case UInt8(ascii: "b"): out.append("\u{08}")
            case UInt8(ascii: "f"): out.append("\u{0C}")
            case UInt8(ascii: "n"): out.append("\n")
            case UInt8(ascii: "r"): out.append("\r")
            case UInt8(ascii: "t"): out.append("\t")
            case UInt8(ascii: "u"):
                guard let unit = hex4() else { return nil }
                if (0xD800...0xDBFF).contains(unit), current == UInt8(ascii: "\\"), index + 1 < bytes.count,
                    bytes[index + 1] == UInt8(ascii: "u")
                {
                    let save = index
                    index += 2
                    if let low = hex4(), (0xDC00...0xDFFF).contains(low) {
                        let combined = 0x10000 + ((unit - 0xD800) << 10) + (low - 0xDC00)
                        out.append(Unicode.Scalar(combined) ?? "\u{FFFD}")
                    } else {
                        index = save
                        out.append("\u{FFFD}")
                    }
                } else {
                    out.append(Unicode.Scalar(unit) ?? "\u{FFFD}")
                }
            default:
                return nil
            }
            runStart = index
        }
        return nil
    }

    mutating func array(depth: Int) -> JSValue? {
        index += 1
        var items: [JSValue] = []
        skipSpace()
        if current == UInt8(ascii: "]") {
            index += 1
            return .array(items)
        }
        while true {
            guard let item = value(depth: depth + 1) else { return nil }
            items.append(item)
            skipSpace()
            switch current {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "]"):
                index += 1
                return .array(items)
            default: return nil
            }
        }
    }

    mutating func object(depth: Int) -> JSValue? {
        index += 1
        var object = JSObject()
        skipSpace()
        if current == UInt8(ascii: "}") {
            index += 1
            return .object(object)
        }
        while true {
            skipSpace()
            guard current == UInt8(ascii: "\""), let key = string() else { return nil }
            skipSpace()
            guard current == UInt8(ascii: ":") else { return nil }
            index += 1
            guard let item = value(depth: depth + 1) else { return nil }
            object[key] = item
            skipSpace()
            switch current {
            case UInt8(ascii: ","): index += 1
            case UInt8(ascii: "}"):
                index += 1
                return .object(object)
            default: return nil
            }
        }
    }
}

/// JavaScript's string-to-number conversion (`StringToNumber`).
enum JavaScriptNumber {
    static func fromString(_ text: String) -> Double {
        let trimmed = JavaScriptWhitespace.trim(text)
        if trimmed.isEmpty { return 0 }
        let bytes = Array(trimmed.utf8)
        if bytes.count > 2, bytes[0] == 48 {
            let radix: Int?
            switch bytes[1] {
            case UInt8(ascii: "x"), UInt8(ascii: "X"): radix = 16
            case UInt8(ascii: "o"), UInt8(ascii: "O"): radix = 8
            case UInt8(ascii: "b"), UInt8(ascii: "B"): radix = 2
            default: radix = nil
            }
            if let radix {
                var value = 0.0
                for byte in bytes[2...] {
                    guard let digit = Int(String(UnicodeScalar(byte)), radix: radix) else { return .nan }
                    value = value * Double(radix) + Double(digit)
                }
                return value
            }
        }
        var body = bytes[...]
        var negative = false
        if let sign = body.first, sign == UInt8(ascii: "+") || sign == UInt8(ascii: "-") {
            negative = sign == UInt8(ascii: "-")
            body = body.dropFirst()
        }
        if Array(body) == Array("Infinity".utf8) { return negative ? -.infinity : .infinity }
        // StrUnsignedDecimalLiteral: digits [. digits] | . digits, then an optional exponent.
        var position = body.startIndex
        func digitRun() -> Int {
            var count = 0
            while position < body.endIndex, body[position] >= 48, body[position] <= 57 {
                position += 1
                count += 1
            }
            return count
        }
        let whole = digitRun()
        var fraction = 0
        if position < body.endIndex, body[position] == UInt8(ascii: ".") {
            position += 1
            fraction = digitRun()
        }
        guard whole + fraction > 0 else { return .nan }
        if position < body.endIndex, body[position] == UInt8(ascii: "e") || body[position] == UInt8(ascii: "E") {
            position += 1
            if position < body.endIndex, body[position] == UInt8(ascii: "+") || body[position] == UInt8(ascii: "-") {
                position += 1
            }
            guard digitRun() > 0 else { return .nan }
        }
        guard position == body.endIndex else { return .nan }
        var literal = String(decoding: body, as: UTF8.self)
        if literal.hasPrefix(".") { literal = "0" + literal }
        if literal.hasSuffix(".") { literal += "0" }
        literal = literal.replacingOccurrences(of: ".e", with: ".0e").replacingOccurrences(of: ".E", with: ".0E")
        guard let magnitude = Double(literal) else { return .nan }
        return negative ? -magnitude : magnitude
    }
}

extension JSValue {
    /// The value for the envelope's writer: an integral number in `Int` range as an integer,
    /// so the response text matches `JSON.stringify`.
    var envelopeValue: JSONValue {
        switch self {
        case .null: return .null
        case .bool(let flag): return .bool(flag)
        case .number(let value):
            guard value.isFinite else { return .null }
            if value.rounded(.towardZero) == value, abs(value) < 9.0e15, let exact = Int(exactly: value) {
                return .int(exact)
            }
            return .double(value)
        case .string(let text): return .string(text)
        case .array(let items): return .array(items.map(\.envelopeValue))
        case .object(let object):
            return .object(Dictionary(uniqueKeysWithValues: object.entries.map { ($0.0, $0.1.envelopeValue) }))
        }
    }
}

extension RequestBody {
    /// `req.body` as JavaScript holds it, for routes whose values are stored or compared as
    /// JSON text: nil without a body, else body-parser's strict `JSON.parse`.
    static func parseJavaScript(_ data: Data?) throws -> JSValue? {
        guard let data, !data.isEmpty else { return nil }
        let first = data.first { ![0x20, 0x09, 0x0A, 0x0D].contains($0) }
        guard first == UInt8(ascii: "{") || first == UInt8(ascii: "[") else { throw malformed }
        guard let value = JSValue.parse(data) else { throw malformed }
        return value
    }
}
