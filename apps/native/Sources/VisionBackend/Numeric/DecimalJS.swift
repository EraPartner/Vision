import Foundation

/// A value `decimal.js` cannot hold as a finite number, or text it refuses.
struct DecimalJSError: Error, Equatable, Sendable, CustomStringConvertible {
    let input: String
    var description: String { "[DecimalError] Invalid argument: \(input)" }
}

/// `decimal.js` arithmetic as `packages/shared-utils/src/money.ts` configures it
/// (`precision: 30`, `ROUND_HALF_EVEN`), for the services that compute with `toDecimal`
/// and the analysis formula engine, which computes with `Decimal` directly (ADR-270). The
/// persistence layer's `ExactDecimal` is PostgreSQL NUMERIC and rounds
/// differently, so a ported service that compared or printed `Decimal` values uses this type.
///
/// A value is `coefficient × 10^exponent` without trailing zeros, as `decimal.js` normalizes
/// it. The constructor keeps every digit; `plus`, `minus`, `times` and `dividedBy` round the
/// result to 30 significant digits. Only finite values exist here: text that `decimal.js`
/// reads as `NaN` or an infinity is reported by `parse` and refused by `init`. The sign of
/// zero is not kept; no ported caller can observe it.
struct DecimalJS: Sendable, Hashable, CustomStringConvertible {
    enum Rounding: Sendable {
        /// `Decimal.ROUND_HALF_EVEN`, the module default.
        case halfEven
        /// `Decimal.ROUND_HALF_UP`: ties away from zero.
        case halfUp
    }

    static let precision = 30
    static let zero = DecimalJS(normalizing: .zero, exponent: 0)
    static let one = DecimalJS(normalizing: .one, exponent: 0)

    let coefficient: ExactInteger
    let exponent: Int

    init(normalizing coefficient: ExactInteger, exponent: Int) {
        guard !coefficient.isZero else {
            self.coefficient = .zero
            self.exponent = 0
            return
        }
        let digits = coefficient.magnitudeDigits.utf8
        var trailing = 0
        for byte in digits.reversed() {
            guard byte == UInt8(ascii: "0") else { break }
            trailing += 1
        }
        self.coefficient = trailing == 0 ? coefficient : coefficient / ExactInteger.pow10(trailing)
        self.exponent = exponent + trailing
    }

    init(_ value: Int) {
        self.init(normalizing: ExactInteger(value), exponent: 0)
    }

    /// `new Decimal(text)` for text that holds a finite value; see `parse` for the grammar.
    init(_ text: String) throws {
        guard case .finite(let value) = Self.parse(text) else { throw DecimalJSError(input: text) }
        self = value
    }

    /// `new Decimal(number)`: the digits of JavaScript's `String(number)`.
    init(_ number: Double) throws {
        guard number.isFinite else { throw DecimalJSError(input: SQLArguments.javaScriptText(number)) }
        try self.init(SQLArguments.javaScriptText(number))
    }

    /// `toDecimal(value)` of `money.ts`: nullish and the empty string are zero.
    static func from(_ text: String?) throws -> DecimalJS {
        guard let text, !text.isEmpty else { return .zero }
        return try DecimalJS(text)
    }

    // MARK: Rounding

    /// Drops `count` low digits of `coefficient`. `inexact` says digits beyond the
    /// coefficient were already discarded (a division remainder), so a tie is not a tie.
    private static func dropDigits(
        _ coefficient: ExactInteger, _ count: Int, _ rounding: Rounding, inexact: Bool = false
    ) -> ExactInteger {
        guard count > 0 else { return coefficient }
        let divisor = ExactInteger.pow10(count)
        let (quotient, remainder) = coefficient.magnitude.quotientAndRemainder(dividingBy: divisor)
        let half = ExactInteger(5).timesPow10(count - 1)
        let roundUp: Bool
        if remainder > half {
            roundUp = true
        } else if remainder < half {
            roundUp = false
        } else if inexact {
            roundUp = true
        } else {
            switch rounding {
            case .halfUp: roundUp = true
            case .halfEven: roundUp = quotient.magnitudeRemainder(dividingBy: 2) == 1
            }
        }
        let magnitude = roundUp ? quotient + .one : quotient
        return coefficient.signum < 0 ? -magnitude : magnitude
    }

    /// `finalise(x, precision, rounding)`: at most 30 significant digits.
    static func finalised(_ coefficient: ExactInteger, _ exponent: Int, inexact: Bool = false) -> DecimalJS {
        let excess = coefficient.isZero ? 0 : coefficient.digitCount - precision
        guard excess > 0 else { return DecimalJS(normalizing: coefficient, exponent: exponent) }
        return DecimalJS(
            normalizing: dropDigits(coefficient, excess, .halfEven, inexact: inexact), exponent: exponent + excess)
    }

    /// `toDecimalPlaces(places, rounding)`.
    func toDecimalPlaces(_ places: Int, _ rounding: Rounding = .halfEven) -> DecimalJS {
        let drop = -exponent - places
        guard drop > 0 else { return self }
        return DecimalJS(normalizing: Self.dropDigits(coefficient, drop, rounding), exponent: -places)
    }

    // MARK: Arithmetic

    private static func aligned(_ a: DecimalJS, _ b: DecimalJS) -> (ExactInteger, ExactInteger, Int) {
        let exponent = Swift.min(a.exponent, b.exponent)
        return (a.coefficient.timesPow10(a.exponent - exponent), b.coefficient.timesPow10(b.exponent - exponent), exponent)
    }

    func plus(_ other: DecimalJS) -> DecimalJS {
        let (left, right, exponent) = Self.aligned(self, other)
        return Self.finalised(left + right, exponent)
    }

    func minus(_ other: DecimalJS) -> DecimalJS {
        let (left, right, exponent) = Self.aligned(self, other)
        return Self.finalised(left - right, exponent)
    }

    func times(_ other: DecimalJS) -> DecimalJS {
        Self.finalised(coefficient * other.coefficient, exponent + other.exponent)
    }

    /// `dividedBy`. A zero divisor gives an infinity or `NaN` in `decimal.js`; refused here.
    func dividedBy(_ other: DecimalJS) throws -> DecimalJS {
        guard !other.coefficient.isZero else { throw DecimalJSError(input: "\(self) / 0") }
        // Enough quotient digits that 30 significant ones and a guard digit are exact.
        let shift = Swift.max(0, Self.precision + 2 + other.coefficient.digitCount - coefficient.digitCount)
        let (quotient, remainder) = coefficient.timesPow10(shift).quotientAndRemainder(dividingBy: other.coefficient)
        return Self.finalised(quotient, exponent - other.exponent - shift, inexact: !remainder.isZero)
    }

    var abs: DecimalJS { DecimalJS(normalizing: coefficient.magnitude, exponent: exponent) }
    var negated: DecimalJS { DecimalJS(normalizing: -coefficient, exponent: exponent) }
    var isZero: Bool { coefficient.isZero }

    /// `cmp`: -1, 0 or 1.
    func compared(to other: DecimalJS) -> Int {
        let (left, right, _) = Self.aligned(self, other)
        return left < right ? -1 : (left == right ? 0 : 1)
    }

    func eq(_ other: DecimalJS) -> Bool { compared(to: other) == 0 }
    func gt(_ other: DecimalJS) -> Bool { compared(to: other) > 0 }
    func gte(_ other: DecimalJS) -> Bool { compared(to: other) >= 0 }
    func lt(_ other: DecimalJS) -> Bool { compared(to: other) < 0 }
    func lte(_ other: DecimalJS) -> Bool { compared(to: other) <= 0 }

    static func max(_ a: DecimalJS, _ b: DecimalJS) -> DecimalJS { a.gte(b) ? a : b }

    // MARK: Output

    /// `toFixed()`: plain notation with every digit and no trailing zeros.
    var description: String {
        guard !coefficient.isZero else { return "0" }
        let digits = coefficient.magnitudeDigits
        let sign = coefficient.signum < 0 ? "-" : ""
        if exponent >= 0 { return sign + digits + String(repeating: "0", count: exponent) }
        let scale = -exponent
        let padded = digits.count <= scale ? String(repeating: "0", count: scale + 1 - digits.count) + digits : digits
        let split = padded.index(padded.endIndex, offsetBy: -scale)
        return sign + String(padded[..<split]) + "." + String(padded[split...])
    }

    var toFixed: String { description }

    /// `toNumber()`: the nearest double.
    var toNumber: Double {
        guard !coefficient.isZero else { return 0 }
        let sign = coefficient.signum < 0 ? "-" : ""
        return Double("\(sign)\(coefficient.magnitudeDigits)e\(exponent)") ?? .nan
    }
}
