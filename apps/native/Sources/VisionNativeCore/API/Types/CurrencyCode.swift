import Foundation

/// An ISO 4217 style currency code: exactly three ASCII capital letters (`^[A-Z]{3}$`, the
/// pattern of `CurrencyCode` in `packages/types/src/brands.ts`). Decoding rejects anything
/// else with a `DecodingError`, as the web client's zod schema does.
public struct CurrencyCode: RawRepresentable, Hashable, Comparable, Sendable, Codable, CustomStringConvertible {
    public let rawValue: String

    /// `nil` unless `rawValue` matches `^[A-Z]{3}$`.
    public init?(rawValue: String) {
        guard Self.isValid(rawValue) else { return nil }
        self.rawValue = rawValue
    }

    /// Throws `CurrencyCodeError.invalid` unless `code` matches `^[A-Z]{3}$`.
    public init(validating code: String) throws {
        guard Self.isValid(code) else { throw CurrencyCodeError.invalid(code) }
        self.rawValue = code
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        let text = try container.decode(String.self)
        guard Self.isValid(text) else {
            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "\"\(text)\" is not a currency code (^[A-Z]{3}$).")
        }
        self.rawValue = text
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }

    /// The app's fallback currency, the web settings default (`DEFAULT_APP_SETTINGS.defaultCurrency`).
    public static let eur = CurrencyCode(uncheckedValid: "EUR")

    private init(uncheckedValid rawValue: String) {
        self.rawValue = rawValue
    }

    /// Whether `text` is exactly three ASCII capital letters.
    public static func isValid(_ text: String) -> Bool {
        let bytes = text.utf8
        return bytes.count == 3 && bytes.allSatisfy { $0 >= 0x41 && $0 <= 0x5A }
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

public enum CurrencyCodeError: Error, Equatable, Sendable {
    case invalid(String)
}
