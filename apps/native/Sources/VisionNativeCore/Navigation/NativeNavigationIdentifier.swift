import Foundation

/// `Number(useParams().id)` for the opt-in native router. Binary64 coercion is
/// confined to route identifier text; financial values continue to use Decimal.
/// Matching/percent decoding happens before this parser, exactly once.
public struct NativeNavigationIdentifier: Sendable {
    public enum Category: Equatable, Sendable { case finite, nonFinite }

    private let number: Double
    public var category: Category { number.isFinite ? .finite : .nonFinite }

    public init(_ parameter: String) {
        number = Self.coerce(parameter.trimmingCharacters(in: Self.whitespace))
    }

    /// Apply the consumer's identifier bound after source Number coercion. The
    /// exact Int conversion also rejects fractions and values outside Int's range.
    public func positiveInteger(upTo maximum: Int) -> Int? {
        guard number.isFinite, number > 0, let value = Int(exactly: number), value <= maximum else { return nil }
        return value
    }

    private static let whitespace = CharacterSet(
        charactersIn:
            "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D} \u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
    )

    private static func coerce(_ text: String) -> Double {
        if text.isEmpty { return 0 }
        if ["Infinity", "+Infinity"].contains(text) { return .infinity }
        if text == "-Infinity" { return -.infinity }
        if text.hasPrefix("0x") || text.hasPrefix("0X") {
            let digits = text.dropFirst(2)
            guard !digits.isEmpty, digits.utf8.allSatisfy({ byte in
                (0x30...0x39).contains(byte) || (0x41...0x46).contains(byte) || (0x61...0x66).contains(byte)
            }) else { return .nan }
            return Double(text) ?? .nan
        }
        if text.hasPrefix("0b") || text.hasPrefix("0B") { return radixNumber(text.dropFirst(2), bitsPerDigit: 1) }
        if text.hasPrefix("0o") || text.hasPrefix("0O") { return radixNumber(text.dropFirst(2), bitsPerDigit: 3) }
        // Double's own grammar additionally accepts inf/nan and hexadecimal
        // floating-point literals. ECMAScript Number(string) accepts none of those.
        guard text.range(
            of: #"\A[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\z"#,
            options: .regularExpression) != nil
        else { return .nan }
        return Double(text) ?? .nan
    }

    /// Binary/octal integers are powers-of-two encodings. Re-encode their bits
    /// without rounding, then let Double perform one correctly rounded conversion.
    private static func radixNumber(_ digits: Substring, bitsPerDigit: Int) -> Double {
        let maximumDigit = UInt8((1 << bitsPerDigit) - 1)
        guard !digits.isEmpty, digits.utf8.allSatisfy({ $0 >= 0x30 && $0 <= 0x30 + maximumDigit }) else {
            return .nan
        }
        let padding = (4 - (digits.utf8.count * bitsPerDigit) % 4) % 4
        var bits = String(repeating: "0", count: padding)
        for digit in digits.utf8 {
            let binary = String(digit - 0x30, radix: 2)
            bits += String(repeating: "0", count: bitsPerDigit - binary.count) + binary
        }
        let bytes = Array(bits.utf8)
        let alphabet = Array("0123456789abcdef")
        var hexadecimal = "0x"
        for index in stride(from: 0, to: bytes.count, by: 4) {
            var nibble = 0
            for bit in bytes[index..<(index + 4)] { nibble = nibble * 2 + Int(bit - 0x30) }
            hexadecimal.append(alphabet[nibble])
        }
        return Double(hexadecimal) ?? .nan
    }
}
