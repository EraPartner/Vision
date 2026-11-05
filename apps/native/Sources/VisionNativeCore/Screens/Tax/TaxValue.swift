import Foundation

/// Editable tax JSON. Numeric fields retain Decimal precision, including unknown fields
/// carried through settings edits; the generic runtime JSONValue remains an opaque CAS token.
public enum TaxValue: Codable, Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Decimal)
    case string(String)
    case array([TaxValue])
    case object([String: TaxValue])

    public init(from decoder: any Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() {
            self = .null
        } else if let result = try? value.decode(Bool.self) {
            self = .bool(result)
        } else if let result = try? value.decode(String.self) {
            self = .string(result)
        } else if let result = try? value.decode(Decimal.self) {
            self = .number(result)
        } else if let result = try? value.decode([TaxValue].self) {
            self = .array(result)
        } else {
            self = .object(try value.decode([String: TaxValue].self))
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let result): try value.encode(result)
        case .number(let result): try value.encode(result)
        case .string(let result): try value.encode(result)
        case .array(let result): try value.encode(result)
        case .object(let result): try value.encode(result)
        }
    }

    public init<T: Encodable>(encoding value: T) throws {
        self = try JSONDecoder().decode(Self.self, from: APIBody.encode(value))
    }

    public func decode<T: Decodable>(_ type: T.Type) throws -> T {
        try JSONDecoder().decode(type, from: APIBody.encode(self))
    }

    public subscript(_ key: String) -> TaxValue? {
        get {
            if case .object(let fields) = self { return fields[key] }
            return nil
        }
        set {
            guard case .object(var fields) = self else { return }
            fields[key] = newValue
            self = .object(fields)
        }
    }

    public var objectValue: [String: TaxValue]? {
        if case .object(let value) = self { return value }
        return nil
    }
    public var arrayValue: [TaxValue]? {
        if case .array(let value) = self { return value }
        return nil
    }
    public var decimalValue: Decimal? {
        if case .number(let value) = self { return value }
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
}
