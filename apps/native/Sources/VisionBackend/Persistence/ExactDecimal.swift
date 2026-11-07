import Foundation

/// A failure that carries PostgreSQL's SQLSTATE for the same failure (ADR-263): `NumericError`,
/// `TimeError` and the other errors of the SQL functions. Inside SQLite it travels as a
/// `vision:<sqlstate>:<constraint>:<message>` function error (see `DatabaseError`).
public struct SQLStateError: Error, Equatable, Sendable, CustomStringConvertible {
    public let code: String
    public let message: String
    public init(_ message: String, code: String) {
        self.message = message
        self.code = code
    }
    public var description: String { message }
}

/// Exact decimal arithmetic with PostgreSQL NUMERIC semantics: a port of
/// `apps/node-backend/src/database/sqlite/numeric.ts` (ADR-263, ADR-270).
///
/// Vision stores NUMERIC columns as text in PostgreSQL's output form ("12.3400"). A value is a
/// coefficient and a display scale: 12.3400 is `(123400, 4)`. Addition and subtraction keep
/// the larger scale, multiplication adds the scales, division picks `select_div_scale()`,
/// rounding is half away from zero, and a value that does not fit NUMERIC(p,s) raises
/// "numeric field overflow".
public struct ExactDecimal: Sendable, Hashable, CustomStringConvertible {
    public let coefficient: ExactInteger
    public let scale: Int

    public init(coefficient: ExactInteger, scale: Int) {
        self.coefficient = coefficient
        self.scale = scale
    }

    /// PostgreSQL's text output with the display scale.
    public var description: String {
        let digits = coefficient.magnitudeDigits
        let sign = coefficient.isNegative ? "-" : ""
        if scale == 0 { return sign + digits }
        let padded = digits.count < scale + 1 ? String(repeating: "0", count: scale + 1 - digits.count) + digits : digits
        let split = padded.index(padded.endIndex, offsetBy: -scale)
        return sign + String(padded[..<split]) + "." + String(padded[split...])
    }

    // MARK: Limits

    /// NUMERIC_MAX_DISPLAY_SCALE: the largest scale division picks.
    static let maxDisplayScale = 1000
    /// NUMERIC_DSCALE_MAX: the largest scale a value can carry.
    static let dscaleMax = 16383
    /// (NUMERIC_WEIGHT_MAX + 1) * DEC_DIGITS: the integer digits a value may have.
    static let maxIntegerDigits = 131_072
    /// NUMERIC_MAX_PRECISION: the typmod limits.
    static let maxPrecision = 1000
    /// NUMERIC_MIN_SIG_DIGITS.
    static let minSignificantDigits = 16
    /// DEC_DIGITS: decimal digits per NBASE digit.
    static let decDigits = 4
    /// The scale bounds numeric_round() and numeric_trunc() clamp to.
    static let minRoundScale = -maxIntegerDigits - 1

    static func invalidSyntax(_ value: String) -> SQLStateError {
        SQLStateError("invalid input syntax for type numeric: \"\(value)\"", code: "22P02")
    }

    static func formatOverflow() -> SQLStateError {
        SQLStateError("value overflows numeric format", code: "22003")
    }

    static func divisionByZero() -> SQLStateError {
        SQLStateError("division by zero", code: "22012")
    }

    /// make_result()'s range check: at most 131072 integer digits and 16383 decimals.
    static func checked(_ value: ExactDecimal) throws -> ExactDecimal {
        if value.scale > dscaleMax { throw formatOverflow() }
        // Below 10^1000 a coefficient cannot exceed the integer digits.
        if value.coefficient.digitCount > 1000, value.coefficient.digitCount - value.scale > maxIntegerDigits {
            throw formatOverflow()
        }
        return value
    }

    // MARK: Parsing

    /// C isspace() in the C locale.
    private static func isSpace(_ byte: UInt8?) -> Bool {
        guard let byte else { return false }
        return byte == 0x20 || (byte >= 0x09 && byte <= 0x0D)
    }

    private static func isDigit(_ byte: UInt8?) -> Bool {
        guard let byte else { return false }
        return byte >= 0x30 && byte <= 0x39
    }

    private static func radixDigit(_ byte: UInt8?, radix: Int) -> UInt32? {
        guard let byte else { return nil }
        let value: UInt32
        switch byte {
        case 0x30...0x39: value = UInt32(byte - 0x30)
        case 0x41...0x46: value = UInt32(byte - 0x41 + 10)
        case 0x61...0x66: value = UInt32(byte - 0x61 + 10)
        default: return nil
        }
        return value < UInt32(radix) ? value : nil
    }

    /// `parseDecimalText`: PostgreSQL 18's numeric_in. Surrounding C-locale whitespace, an
    /// optional sign, digits with single `_` separators, an optional point and exponent, or a
    /// `0x`/`0o`/`0b` integer. NaN and the infinities are refused.
    public static func parse(_ text: String) throws -> ExactDecimal {
        let bytes = Array(text.utf8)
        var i = 0
        func at(_ k: Int) -> UInt8? { k < bytes.count ? bytes[k] : nil }
        while isSpace(at(i)) { i += 1 }
        var negative = false
        if at(i) == UInt8(ascii: "+") {
            i += 1
        } else if at(i) == UInt8(ascii: "-") {
            negative = true
            i += 1
        }
        if !isDigit(at(i)) && at(i) != UInt8(ascii: ".") {
            let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.range(of: #"^(nan|[+-]?(inf|infinity))\s*$"#, options: [.regularExpression, .caseInsensitive])
                != nil
            {
                throw SQLStateError("NaN and infinite values are not supported: \"\(text)\"", code: "22P02")
            }
            throw invalidSyntax(text)
        }
        var digits: ExactInteger
        var digitText: Substring = ""
        var fracLength = 0
        var exponent = 0
        let radixMark = at(i) == UInt8(ascii: "0") ? at(i + 1) : nil
        let radix: Int
        switch radixMark {
        case UInt8(ascii: "x"), UInt8(ascii: "X"): radix = 16
        case UInt8(ascii: "o"), UInt8(ascii: "O"): radix = 8
        case UInt8(ascii: "b"), UInt8(ascii: "B"): radix = 2
        default: radix = 10
        }
        if radix != 10 {
            i += 2
            var value = ExactInteger.zero
            var count = 0
            let radixValue = ExactInteger(radix)
            while true {
                if let digit = radixDigit(at(i), radix: radix) {
                    value = value * radixValue + ExactInteger(Int(digit))
                    count += 1
                    i += 1
                } else if at(i) == UInt8(ascii: "_") {
                    i += 1
                    if radixDigit(at(i), radix: radix) == nil { throw invalidSyntax(text) }
                } else {
                    break
                }
            }
            if count == 0 { throw invalidSyntax(text) }
            digits = value
        } else {
            var haveDot = false
            if at(i) == UInt8(ascii: ".") {
                haveDot = true
                i += 1
            }
            if !isDigit(at(i)) { throw invalidSyntax(text) }
            var collected: [UInt8] = []
            while true {
                let c = at(i)
                if isDigit(c), let c {
                    collected.append(c)
                    if haveDot { fracLength += 1 }
                    i += 1
                } else if c == UInt8(ascii: ".") {
                    if haveDot { throw invalidSyntax(text) }
                    haveDot = true
                    i += 1
                    if at(i) == UInt8(ascii: "_") { throw invalidSyntax(text) }
                } else if c == UInt8(ascii: "_") {
                    i += 1
                    if !isDigit(at(i)) { throw invalidSyntax(text) }
                } else {
                    break
                }
            }
            if at(i) == UInt8(ascii: "e") || at(i) == UInt8(ascii: "E") {
                i += 1
                var expNegative = false
                if at(i) == UInt8(ascii: "+") {
                    i += 1
                } else if at(i) == UInt8(ascii: "-") {
                    expNegative = true
                    i += 1
                }
                if !isDigit(at(i)) { throw invalidSyntax(text) }
                while true {
                    let c = at(i)
                    if isDigit(c), let c {
                        exponent = exponent * 10 + Int(c - 0x30)
                        if exponent > 1_073_741_823 { throw formatOverflow() }  // PG_INT32_MAX / 2
                        i += 1
                    } else if c == UInt8(ascii: "_") {
                        i += 1
                        if !isDigit(at(i)) { throw invalidSyntax(text) }
                    } else {
                        break
                    }
                }
                if expNegative { exponent = -exponent }
            }
            let firstSignificant = collected.firstIndex { $0 != 0x30 } ?? collected.count
            digitText = Substring(String(decoding: collected[firstSignificant...], as: UTF8.self))
            digits = digitText.isEmpty ? .zero : ExactInteger(decimalDigits: digitText) ?? .zero
        }
        while isSpace(at(i)) { i += 1 }
        if i < bytes.count { throw invalidSyntax(text) }

        // value = digits * 10^(exponent - fracLength), display scale max(0, fracLength - exponent)
        let scale = max(0, fracLength - exponent)
        if scale > dscaleMax { throw formatOverflow() }
        if digits.isZero { return ExactDecimal(coefficient: .zero, scale: scale) }
        let significant = radix == 10 ? digitText.count : digits.digitCount
        if significant + exponent - fracLength > maxIntegerDigits { throw formatOverflow() }
        let magnitude = digits.timesPow10(scale - fracLength + exponent)
        return ExactDecimal(coefficient: negative ? -magnitude : magnitude, scale: scale)
    }

    // MARK: Rounding

    private func upscaled(to target: Int) -> ExactInteger {
        precondition(target >= scale, "upscale to a smaller scale")
        return coefficient.timesPow10(target - scale)
    }

    /// Integer division rounded half away from zero (`d > 0`).
    static func divideRoundingHalfAway(_ n: ExactInteger, _ d: ExactInteger) -> ExactInteger {
        let (q, r) = n.quotientAndRemainder(dividingBy: d)
        if r.isZero { return q }
        let twice = r.magnitude + r.magnitude
        return twice >= d ? q + ExactInteger(n.isNegative ? -1 : 1) : q
    }

    private static func clampRoundScale(_ scale: Int) -> Int {
        min(max(scale, minRoundScale), dscaleMax)
    }

    /// round(x, s): half away from zero; a negative scale rounds to tens, hundreds, ...
    public func rounded(toScale requested: Int) throws -> ExactDecimal {
        try Self.checked(roundedUnchecked(Self.clampRoundScale(requested)))
    }

    private func roundedUnchecked(_ target: Int) -> ExactDecimal {
        if target >= scale { return ExactDecimal(coefficient: upscaled(to: target), scale: target) }
        if target >= 0 {
            return ExactDecimal(
                coefficient: Self.divideRoundingHalfAway(coefficient, .pow10(scale - target)), scale: target)
        }
        let unit = ExactInteger.pow10(scale - target)
        let rounded = Self.divideRoundingHalfAway(coefficient, unit).timesPow10(-target)
        return ExactDecimal(coefficient: rounded, scale: 0)
    }

    /// trunc(x, s): toward zero.
    public func truncated(toScale requested: Int) -> ExactDecimal {
        let target = Self.clampRoundScale(requested)
        if target >= scale { return ExactDecimal(coefficient: upscaled(to: target), scale: target) }
        if target >= 0 {
            return ExactDecimal(coefficient: coefficient / .pow10(scale - target), scale: target)
        }
        let unit = ExactInteger.pow10(scale - target)
        return ExactDecimal(coefficient: (coefficient / unit).timesPow10(-target), scale: 0)
    }

    // MARK: Arithmetic

    public static func add(_ a: ExactDecimal, _ b: ExactDecimal) throws -> ExactDecimal {
        let target = max(a.scale, b.scale)
        return try checked(ExactDecimal(coefficient: a.upscaled(to: target) + b.upscaled(to: target), scale: target))
    }

    public static func subtract(_ a: ExactDecimal, _ b: ExactDecimal) throws -> ExactDecimal {
        let target = max(a.scale, b.scale)
        return try checked(ExactDecimal(coefficient: a.upscaled(to: target) - b.upscaled(to: target), scale: target))
    }

    /// The exact product; a scale above 16383 is rounded to it, as PostgreSQL does.
    public static func multiply(_ a: ExactDecimal, _ b: ExactDecimal) throws -> ExactDecimal {
        let target = a.scale + b.scale
        let product = ExactDecimal(coefficient: a.coefficient * b.coefficient, scale: target)
        if target <= dscaleMax { return try checked(product) }
        return try product.rounded(toScale: dscaleMax)
    }

    public var negated: ExactDecimal { ExactDecimal(coefficient: -coefficient, scale: scale) }
    public var absolute: ExactDecimal { ExactDecimal(coefficient: coefficient.magnitude, scale: scale) }
    public var signum: Int { coefficient.signum }

    public static func compare(_ a: ExactDecimal, _ b: ExactDecimal) -> Int {
        let target = max(a.scale, b.scale)
        let x = a.upscaled(to: target)
        let y = b.upscaled(to: target)
        return x < y ? -1 : (x > y ? 1 : 0)
    }

    /// Weight and first digit of |value| in PostgreSQL's base-10000 form; zero is (0, 0).
    private var nbaseLead: (weight: Int, first: Int) {
        let magnitude = coefficient.magnitude
        if magnitude.isZero { return (0, 0) }
        let e = magnitude.digitCount - 1 - scale
        // floor(e / 4), also for negative exponents.
        let weight = e >= 0 ? e / Self.decDigits : -((-e + Self.decDigits - 1) / Self.decDigits)
        let shift = scale + weight * Self.decDigits
        let first = shift >= 0 ? magnitude / .pow10(shift) : magnitude.timesPow10(-shift)
        return (weight, Int(first.magnitudeRemainder(dividingBy: 10_000)))
    }

    /// select_div_scale(): the display scale of a quotient.
    public static func divisionScale(_ a: ExactDecimal, _ b: ExactDecimal) -> Int {
        let lead1 = a.nbaseLead
        let lead2 = b.nbaseLead
        var qweight = lead1.weight - lead2.weight
        if lead1.first <= lead2.first { qweight -= 1 }
        var rscale = minSignificantDigits - qweight * decDigits
        rscale = max(rscale, a.scale, b.scale, 0)
        return min(rscale, maxDisplayScale)
    }

    /// a / b at `scale` decimals, rounded half away from zero.
    public static func divide(_ a: ExactDecimal, _ b: ExactDecimal, scale target: Int) throws -> ExactDecimal {
        if b.coefficient.isZero { throw divisionByZero() }
        let exponent = b.scale + target - a.scale
        var numerator = a.coefficient
        var denominator = b.coefficient
        if exponent >= 0 {
            numerator = numerator.timesPow10(exponent)
        } else {
            denominator = denominator.timesPow10(-exponent)
        }
        if denominator.isNegative {
            numerator = -numerator
            denominator = -denominator
        }
        return ExactDecimal(coefficient: divideRoundingHalfAway(numerator, denominator), scale: target)
    }

    public static func divide(_ a: ExactDecimal, _ b: ExactDecimal) throws -> ExactDecimal {
        if b.coefficient.isZero { throw divisionByZero() }
        return try divide(a, b, scale: divisionScale(a, b))
    }

    /// Numeric modulo: the dividend's sign, the wider input's scale.
    public static func modulo(_ a: ExactDecimal, _ b: ExactDecimal) throws -> ExactDecimal {
        if b.coefficient.isZero { throw divisionByZero() }
        let target = max(a.scale, b.scale)
        return ExactDecimal(coefficient: a.upscaled(to: target) % b.upscaled(to: target), scale: target)
    }

    public var floor: ExactDecimal {
        let t = truncated(toScale: 0)
        if coefficient.isNegative, Self.compare(t, self) != 0 {
            return ExactDecimal(coefficient: t.coefficient - .one, scale: 0)
        }
        return t
    }

    public var ceiling: ExactDecimal {
        let t = truncated(toScale: 0)
        if coefficient.signum > 0, Self.compare(t, self) != 0 {
            return ExactDecimal(coefficient: t.coefficient + .one, scale: 0)
        }
        return t
    }

    // MARK: Typmods and conversions

    /// numerictypmodin's limits, SQLSTATE 22023.
    public static func checkTypmod(precision: Int, scale: Int) throws {
        if precision < 1 || precision > maxPrecision {
            throw SQLStateError("NUMERIC precision \(precision) must be between 1 and \(maxPrecision)", code: "22023")
        }
        if scale < -maxPrecision || scale > maxPrecision {
            throw SQLStateError(
                "NUMERIC scale \(scale) must be between \(-maxPrecision) and \(maxPrecision)", code: "22023")
        }
    }

    /// apply_typmod: round to `scale`, then refuse a nonzero value whose leading digit lies
    /// above `precision - scale`.
    public func coerced(precision: Int, scale target: Int) throws -> ExactDecimal {
        try Self.checkTypmod(precision: precision, scale: target)
        let rounded = try rounded(toScale: target)
        let maxDigits = precision - target
        if !rounded.coefficient.isZero {
            let position = rounded.coefficient.digitCount - rounded.scale
            if position > maxDigits {
                throw SQLStateError(
                    "numeric field overflow: a field with precision \(precision), scale \(target) must round to an "
                        + "absolute value less than \(maxDigits == 0 ? "1" : "10^\(maxDigits)")",
                    code: "22003")
            }
        }
        return rounded
    }

    /// numeric::bigint: half away from zero; outside the int8 range raises 22003.
    public func integerValue() throws -> Int64 {
        guard let value = try rounded(toScale: 0).coefficient.int64Value else {
            throw SQLStateError("bigint out of range", code: "22003")
        }
        return value
    }

    /// `dec_key`: text that sorts like the number. A class digit (0 negative, 1 zero,
    /// 2 positive), a fixed-width exponent, then the significant digits; negative values
    /// complement both so that a larger magnitude sorts first.
    public var sortKey: String {
        if coefficient.isZero { return "1" }
        let all = coefficient.magnitudeDigits
        var digits = Substring(all)
        while digits.last == "0" { digits.removeLast() }
        let exponent = all.count - 1 - scale
        let biased = String(exponent + 500_000)
        let exponentField = String(repeating: "0", count: max(0, 7 - biased.count)) + biased
        if coefficient.signum > 0 { return "2" + exponentField + String(digits) }
        func complement<S: StringProtocol>(_ text: S) -> String {
            String(decoding: text.utf8.map { $0 >= 0x30 && $0 <= 0x39 ? 0x39 - ($0 - 0x30) : $0 }, as: UTF8.self)
        }
        // A terminator larger than any complemented digit keeps "-1" < "-1.5" ordered.
        return "0" + complement(exponentField) + complement(digits) + "~"
    }
}
