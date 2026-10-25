import Foundation

/// JSON text written exactly like JavaScript's `JSON.stringify`. The audit receipt's MAC
/// covers `JSON.stringify` output, so field order, number and string encoding must match
/// `packaging/electron/audit-anchor.ts` byte for byte. `JSONValue` objects are unordered,
/// so ordered output is built from this tree instead.
public indirect enum OrderedJSON: Equatable, Sendable {
    case null
    case bool(Bool)
    case int(Int)
    case string(String)
    case array([OrderedJSON])
    case object([(String, OrderedJSON)])

    public static func == (lhs: OrderedJSON, rhs: OrderedJSON) -> Bool {
        lhs.compact == rhs.compact
    }

    /// `JSON.stringify(value)`.
    public var compact: String {
        var output = ""
        write(into: &output)
        return output
    }

    private func write(into output: inout String) {
        switch self {
        case .null: output += "null"
        case .bool(let value): output += value ? "true" : "false"
        case .int(let value): output += String(value)
        case .string(let value): output += AuditJSON.quoted(value)
        case .array(let items):
            output += "["
            for (index, item) in items.enumerated() {
                if index > 0 { output += "," }
                item.write(into: &output)
            }
            output += "]"
        case .object(let fields):
            output += "{"
            for (index, field) in fields.enumerated() {
                if index > 0 { output += "," }
                output += AuditJSON.quoted(field.0)
                output += ":"
                field.1.write(into: &output)
            }
            output += "}"
        }
    }
}

public enum AuditJSON {
    /// A string literal as `JSON.stringify` writes it: `"` and `\` escaped, the short
    /// escapes for backspace, form feed, newline, carriage return and tab, and `\u00xx`
    /// (lowercase hex) for the other control characters. Everything else is literal.
    public static func quoted(_ value: String) -> String {
        var output = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": output += "\\\""
            case "\\": output += "\\\\"
            case "\u{08}": output += "\\b"
            case "\u{0C}": output += "\\f"
            case "\n": output += "\\n"
            case "\r": output += "\\r"
            case "\t": output += "\\t"
            default:
                if scalar.value < 0x20 {
                    let hex = String(scalar.value, radix: 16)
                    output += "\\u" + String(repeating: "0", count: 4 - hex.count) + hex
                } else {
                    output.unicodeScalars.append(scalar)
                }
            }
        }
        output += "\""
        return output
    }

    /// A JSON number as JavaScript prints it, for the values the bridge returns.
    static func number(_ value: Double) -> String {
        if value.isNaN || value.isInfinite { return "null" }
        if value == value.rounded(), abs(value) < 1e21 {
            if abs(value) < 9.0e15 { return String(Int(value)) }
            return String(format: "%.0f", value)
        }
        return String(value)
    }

    /// `JSON.stringify(value, null, 2)` for a `JSONValue`. Object keys are written in
    /// sorted order, because `JSONValue` does not keep the order the backend sent.
    public static func pretty(_ value: JSONValue, indent: String = "") -> String {
        let inner = indent + "  "
        switch value {
        case .null: return "null"
        case .bool(let flag): return flag ? "true" : "false"
        case .int(let number): return String(number)
        case .double(let number): return Self.number(number)
        case .string(let text): return quoted(text)
        case .array(let items):
            if items.isEmpty { return "[]" }
            let body = items.map { inner + pretty($0, indent: inner) }.joined(separator: ",\n")
            return "[\n\(body)\n\(indent)]"
        case .object(let fields):
            if fields.isEmpty { return "{}" }
            let body = fields.keys.sorted().map { key in
                "\(inner)\(quoted(key)): \(pretty(fields[key] ?? .null, indent: inner))"
            }.joined(separator: ",\n")
            return "{\n\(body)\n\(indent)}"
        }
    }

    /// `JSON.stringify(value, null, 2)` for an object whose top-level keys keep the given
    /// order; nested values follow `pretty(_:indent:)`.
    public static func prettyObject(_ fields: [(String, JSONValue)]) -> String {
        if fields.isEmpty { return "{}" }
        let body = fields.map { "  \(quoted($0.0)): \(pretty($0.1, indent: "  "))" }.joined(separator: ",\n")
        return "{\n\(body)\n}"
    }

    /// `Number.isSafeInteger(value)` for a parsed JSON value.
    public static func safeInteger(_ value: JSONValue?) -> Int? {
        guard let value, let number = value.intValue else { return nil }
        let limit = 9_007_199_254_740_991
        return number >= -limit && number <= limit ? number : nil
    }

    /// `/^[0-9a-f]{64}$/`.
    public static func isHash(_ value: JSONValue?) -> Bool {
        guard let text = value?.stringValue else { return false }
        return PathUtilities.isSHA256(text)
    }

    /// `/^[A-Za-z0-9+/]+={0,2}$/`.
    public static func isBase64(_ text: String) -> Bool {
        PathUtilities.fullMatch(text, "[A-Za-z0-9+/]+={0,2}")
    }

    /// `Buffer.from(text, "base64")` for text that passed `isBase64`: missing padding is
    /// tolerated like Node; `nil` when the length cannot be base64.
    public static func base64Bytes(_ text: String) -> Data? {
        guard isBase64(text) else { return nil }
        var padded = text
        let remainder = padded.count % 4
        if remainder == 1 { return nil }
        if remainder > 0 { padded += String(repeating: "=", count: 4 - remainder) }
        return Data(base64Encoded: padded)
    }
}
