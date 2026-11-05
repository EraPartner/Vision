import Foundation

/// A JSON value with JavaScript-like field reads, used for the persisted runtime files
/// (`runtime-state.json`, PID records, manifests, `settings.json`) that the Electron
/// runtime reads as `unknown` and checks field by field.
public enum JSONValue: Sendable, Equatable, Codable {
    case null
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let value = try? container.decode(Bool.self) {
            self = .bool(value)
        } else if let value = try? container.decode(Int.self) {
            self = .int(value)
        } else if let value = try? container.decode(Double.self) {
            self = .double(value)
        } else if let value = try? container.decode(String.self) {
            self = .string(value)
        } else if let value = try? container.decode([JSONValue].self) {
            self = .array(value)
        } else {
            self = .object(try container.decode([String: JSONValue].self))
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .int(let value): try container.encode(value)
        case .double(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    /// Parses JSON text; throws on invalid JSON like `JSON.parse`.
    public static func parse(_ data: Data) throws -> JSONValue {
        try JSONDecoder().decode(JSONValue.self, from: data)
    }

    /// Two-space pretty JSON with sorted keys and a trailing newline.
    public func serialized() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var data = try encoder.encode(self)
        data.append(0x0A)
        return data
    }

    /// Converts an `Encodable` value into a JSON value.
    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONValue.parse(try JSONEncoder().encode(value))
    }

    /// Decodes this JSON value into a `Decodable` type.
    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: try JSONEncoder().encode(self))
    }

    /// `value?.field`: the field of an object, `nil` for anything else.
    public subscript(key: String) -> JSONValue? {
        if case .object(let fields) = self { return fields[key] }
        return nil
    }

    public var objectValue: [String: JSONValue]? {
        if case .object(let fields) = self { return fields }
        return nil
    }

    public var arrayValue: [JSONValue]? {
        if case .array(let items) = self { return items }
        return nil
    }

    public var stringValue: String? {
        if case .string(let value) = self { return value }
        return nil
    }

    public var boolValue: Bool? {
        if case .bool(let value) = self { return value }
        return nil
    }

    /// An integral JSON number (`typeof x === "number" && Number.isInteger(x)`).
    public var intValue: Int? {
        switch self {
        case .int(let value): return value
        case .double(let value):
            guard value.rounded() == value, abs(value) < 9.0e15 else { return nil }
            return Int(value)
        default: return nil
        }
    }

    /// JavaScript `Number(value)` for the value kinds settings files hold.
    public var numberCoercion: Double? {
        switch self {
        case .null: return 0
        case .bool(let value): return value ? 1 : 0
        case .int(let value): return Double(value)
        case .double(let value): return value
        case .string(let text):
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.isEmpty { return 0 }
            return Double(trimmed)
        case .array, .object: return nil
        }
    }

    /// JavaScript truthiness of a JSON value.
    public var isTruthy: Bool {
        switch self {
        case .null: return false
        case .bool(let value): return value
        case .int(let value): return value != 0
        case .double(let value): return value != 0 && !value.isNaN
        case .string(let value): return !value.isEmpty
        case .array, .object: return true
        }
    }
}
