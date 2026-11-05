import Foundation

/// A request-body field that distinguishes "leave unchanged" (`absent`, the key is omitted)
/// from "clear the stored value" (`null`, an explicit JSON `null`) and "set" (`value`).
/// `T?` cannot: synthesized `Codable` drops a `nil`. The generator uses it only for the PATCH
/// fields the web frontend demonstrably sends as `null` (`NULLABLE_PATCH_FIELDS` in
/// `scripts/native-openapi.ts`); every other nullable field stays `T?`.
public enum Nullable<Value: Sendable>: Sendable {
    case absent
    case null
    case value(Value)

    /// `value` for a non-nil argument, otherwise an explicit `null` (a clear).
    public init(clearingIfNil value: Value?) {
        self = value.map { .value($0) } ?? .null
    }

    /// The set value, or `nil` for `absent` and `null`.
    public var wrapped: Value? {
        if case .value(let value) = self { return value }
        return nil
    }

    public var isAbsent: Bool {
        if case .absent = self { return true }
        return false
    }

    public var isNull: Bool {
        if case .null = self { return true }
        return false
    }
}

extension Nullable: Equatable where Value: Equatable {}
extension Nullable: Hashable where Value: Hashable {}

extension Nullable: Encodable where Value: Encodable {
    /// Standalone encoding writes `null` for `absent` too; inside a struct the generated
    /// `encode(to:)` skips absent keys via `encodeNullable`.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .absent, .null: try container.encodeNil()
        case .value(let value): try container.encode(value)
        }
    }
}

extension Nullable: Decodable where Value: Decodable {
    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else {
            self = .value(try container.decode(Value.self))
        }
    }
}

extension KeyedDecodingContainer {
    /// Decodes a key as `absent` (missing), `null` (explicit null) or `value`.
    public func decodeNullable<Value: Decodable & Sendable>(
        _ type: Value.Type, forKey key: Key
    ) throws -> Nullable<Value> {
        guard contains(key) else { return .absent }
        if try decodeNil(forKey: key) { return .null }
        return .value(try decode(type, forKey: key))
    }
}

extension KeyedEncodingContainer {
    /// Omits an `absent` key, writes `null` for `null` and the value otherwise.
    public mutating func encodeNullable<Value: Encodable & Sendable>(
        _ field: Nullable<Value>, forKey key: Key
    ) throws {
        switch field {
        case .absent: break
        case .null: try encodeNil(forKey: key)
        case .value(let value): try encode(value, forKey: key)
        }
    }
}
