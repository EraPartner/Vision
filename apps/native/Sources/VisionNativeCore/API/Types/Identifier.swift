import Foundation

/// The phantom type that makes one entity's identifier a distinct Swift type, so an
/// `AccountID` can never be passed where a `TransactionID` is expected. Conforming tags
/// are generated into `API/Generated/OpenAPIIdentifiers.swift` (one per entity the OpenAPI
/// spec has ids for); mirrors the ADR-220 brands of `packages/types/src/brands.ts`, for
/// every entity rather than ten.
public protocol IdentifierTag: Sendable {}

/// An integer entity id. It encodes and decodes as a bare JSON number, exactly like the
/// `Int` it replaces. The integer literal conformance is for tests and previews; production
/// code takes ids from decoded models.
public struct IntIdentifier<Tag: IdentifierTag>: RawRepresentable, Hashable, Comparable, Sendable, Codable,
    CustomStringConvertible, ExpressibleByIntegerLiteral
{
    public let rawValue: Int

    public init(rawValue: Int) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: Int) {
        self.rawValue = rawValue
    }

    /// Parses decimal text (a route segment or a form field); `nil` when it is not an integer.
    public init?(_ text: String) {
        guard let value = Int(text) else { return nil }
        self.rawValue = value
    }

    public init(integerLiteral value: Int) {
        self.rawValue = value
    }

    public init(from decoder: any Decoder) throws {
        self.rawValue = try decoder.singleValueContainer().decode(Int.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue == rhs.rawValue
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(rawValue)
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var description: String {
        String(rawValue)
    }
}

/// A string entity id (a UUID, or a BIGINT the backend serializes as text). It encodes and
/// decodes as a bare JSON string, exactly like the `String` it replaces.
public struct StringIdentifier<Tag: IdentifierTag>: RawRepresentable, Hashable, Comparable, Sendable, Codable,
    CustomStringConvertible, ExpressibleByStringLiteral
{
    public let rawValue: String

    public init(rawValue: String) {
        self.rawValue = rawValue
    }

    public init(_ rawValue: String) {
        self.rawValue = rawValue
    }

    public init(stringLiteral value: String) {
        self.rawValue = value
    }

    public init(from decoder: any Decoder) throws {
        self.rawValue = try decoder.singleValueContainer().decode(String.self)
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    public static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue == rhs.rawValue
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(rawValue)
    }

    public static func < (lhs: Self, rhs: Self) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    public var description: String {
        rawValue
    }
}

extension APIQuery {
    /// Typed ids and currencies go into paths and queries as their wire text.
    public static func value<Tag: IdentifierTag>(_ value: IntIdentifier<Tag>) -> String {
        String(value.rawValue)
    }

    public static func value<Tag: IdentifierTag>(_ value: StringIdentifier<Tag>) -> String {
        value.rawValue
    }

    public static func value(_ value: CurrencyCode) -> String {
        value.rawValue
    }
}
