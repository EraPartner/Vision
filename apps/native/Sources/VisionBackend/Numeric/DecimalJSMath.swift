import Foundation

// The rest of `decimal.js` 10.6 that the analysis formula engine reaches: the full text
// grammar of `new Decimal(text)`, `Decimal.sum`, `pow`, `sqrt` and `toString`.

extension DecimalJS {
    /// What `new Decimal(text)` holds.
    enum Parsed: Equatable, Sendable {
        case finite(DecimalJS)
        case infinity(negative: Bool)
        case notANumber
        /// `decimal.js` throws `[DecimalError] Invalid argument`.
        case invalid
    }

    /// `EXP_LIMIT`: a larger leading exponent is an infinity, a smaller one is zero.
    private static let exponentLimit = 9_000_000_000_000_000
    /// Stands for any exponent too long to hold; far beyond `exponentLimit` either way.
    private static let hugeExponent = 4_000_000_000_000_000_000
    private static let maximumSafeInteger = 9_007_199_254_740_991

    /// `x.e`: the decimal exponent of the leading digit; 0 for zero.
    var leadingExponent: Int { coefficient.isZero ? 0 : exponent + coefficient.digitCount - 1 }

    /// `finalise(x, precision, rounding)`.
    var roundedToPrecision: DecimalJS { Self.finalised(coefficient, exponent) }

    /// The product with every digit kept (`times` while `external` is off).
    private func exactTimes(_ other: DecimalJS) -> DecimalJS {
        DecimalJS(normalizing: coefficient * other.coefficient, exponent: exponent + other.exponent)
    }

    // MARK: Text

    private static func isDigit(_ byte: UInt8) -> Bool { byte >= 0x30 && byte <= 0x39 }

    private static func digitValue(_ byte: UInt8, base: Int) -> Int? {
        let value: Int
        switch byte {
        case 0x30...0x39: value = Int(byte) - 0x30
        case 0x61...0x66: value = Int(byte) - 0x61 + 10
        case 0x41...0x46: value = Int(byte) - 0x41 + 10
        default: return nil
        }
        return value < base ? value : nil
    }

    /// The digits of `[+-]?\d+` read as an integer, or `hugeExponent` with its sign when
    /// they are too many to matter. `nil` unless every byte after the sign is a digit.
    private static func signedInteger(_ bytes: ArraySlice<UInt8>) -> Int? {
        var body = bytes
        var negative = false
        if let first = body.first, first == UInt8(ascii: "+") || first == UInt8(ascii: "-") {
            negative = first == UInt8(ascii: "-")
            body = body.dropFirst()
        }
        guard !body.isEmpty, body.allSatisfy(isDigit) else { return nil }
        let significant = body.drop { $0 == UInt8(ascii: "0") }
        let magnitude = significant.count > 18 ? hugeExponent : significant.reduce(0) { $0 * 10 + Int($1) - 0x30 }
        return negative ? -magnitude : magnitude
    }

    /// `new Decimal(text)`: an optional sign, then a decimal (`12`, `1.5`, `.5`, `1e-7`), with
    /// single `_` separators between digits, or `Infinity`, `NaN`, or a `0x`, `0b` or `0o`
    /// literal with an optional fraction and binary exponent (`0x1.8p3`). No whitespace.
    static func parse(_ text: String) -> Parsed {
        var bytes = Array(text.utf8)
        var negative = false
        if bytes.first == UInt8(ascii: "-") {
            negative = true
            bytes.removeFirst()
        } else if bytes.first == UInt8(ascii: "+") {
            bytes.removeFirst()
        }
        // `str.replace(/(\d)_(?=\d)/g, '$1')`
        let separated = bytes.contains(UInt8(ascii: "_"))
        if separated {
            var kept: [UInt8] = []
            for (index, byte) in bytes.enumerated() {
                let separator =
                    byte == UInt8(ascii: "_") && index > 0 && index + 1 < bytes.count
                    && isDigit(bytes[index - 1]) && isDigit(bytes[index + 1])
                if !separator { kept.append(byte) }
            }
            bytes = kept
        }
        if let decimal = parseDecimal(bytes, negative: negative) { return decimal }
        if !separated {
            if bytes == Array("Infinity".utf8) { return .infinity(negative: negative) }
            if bytes == Array("NaN".utf8) { return .notANumber }
        }
        return parseRadix(bytes, negative: negative)
    }

    /// `/^(\d+(\.\d*)?|\.\d+)(e[+-]?\d+)?$/i`, then `parseDecimal`. `nil` when it does not match.
    private static func parseDecimal(_ bytes: [UInt8], negative: Bool) -> Parsed? {
        var position = 0
        var digits: [UInt8] = []
        var fractionDigits = 0
        while position < bytes.count, isDigit(bytes[position]) {
            digits.append(bytes[position])
            position += 1
        }
        let wholeDigits = digits.count
        if position < bytes.count, bytes[position] == UInt8(ascii: ".") {
            position += 1
            while position < bytes.count, isDigit(bytes[position]) {
                digits.append(bytes[position])
                fractionDigits += 1
                position += 1
            }
            guard wholeDigits > 0 || fractionDigits > 0 else { return nil }
        } else if wholeDigits == 0 {
            return nil
        }
        var exponent = 0
        if position < bytes.count, bytes[position] == UInt8(ascii: "e") || bytes[position] == UInt8(ascii: "E") {
            guard let value = signedInteger(bytes[(position + 1)...]) else { return nil }
            exponent = value
            position = bytes.count
        }
        guard position == bytes.count,
            let magnitude = ExactInteger(decimalDigits: Substring(String(decoding: digits, as: UTF8.self)))
        else { return nil }
        guard !magnitude.isZero else { return .finite(.zero) }
        if exponent >= hugeExponent { return .infinity(negative: negative) }
        if exponent <= -hugeExponent { return .finite(.zero) }
        let leading = exponent - fractionDigits + magnitude.digitCount - 1
        if leading > exponentLimit { return .infinity(negative: negative) }
        if leading < -exponentLimit { return .finite(.zero) }
        return .finite(DecimalJS(normalizing: negative ? -magnitude : magnitude, exponent: exponent - fractionDigits))
    }

    /// `parseOther` after its decimal and non-finite cases: a hexadecimal, binary or octal
    /// literal, exact but for a binary exponent of 54 or more, which rounds as `Decimal.pow`.
    private static func parseRadix(_ bytes: [UInt8], negative: Bool) -> Parsed {
        guard bytes.count > 2, bytes[0] == UInt8(ascii: "0") else { return .invalid }
        let bitsPerDigit: Int
        switch bytes[1] {
        case UInt8(ascii: "x"), UInt8(ascii: "X"): bitsPerDigit = 4
        case UInt8(ascii: "b"), UInt8(ascii: "B"): bitsPerDigit = 1
        case UInt8(ascii: "o"), UInt8(ascii: "O"): bitsPerDigit = 3
        default: return .invalid
        }
        let base = 1 << bitsPerDigit
        var position = 2
        var mantissa = ExactInteger.zero
        var wholeDigits = 0
        var fractionDigits = 0
        let radix = ExactInteger(base)
        while position < bytes.count, let digit = digitValue(bytes[position], base: base) {
            mantissa = mantissa * radix + ExactInteger(digit)
            wholeDigits += 1
            position += 1
        }
        if position < bytes.count, bytes[position] == UInt8(ascii: ".") {
            position += 1
            while position < bytes.count, let digit = digitValue(bytes[position], base: base) {
                mantissa = mantissa * radix + ExactInteger(digit)
                fractionDigits += 1
                position += 1
            }
            guard wholeDigits > 0 || fractionDigits > 0 else { return .invalid }
        } else if wholeDigits == 0 {
            return .invalid
        }
        var binaryExponent = 0
        if position < bytes.count, bytes[position] == UInt8(ascii: "p") || bytes[position] == UInt8(ascii: "P") {
            guard let value = signedInteger(bytes[(position + 1)...]) else { return .invalid }
            binaryExponent = value
            position = bytes.count
        }
        guard position == bytes.count else { return .invalid }
        guard !mantissa.isZero else { return .finite(.zero) }
        // mantissa / base^fractionDigits, exactly: 2^-n is 5^n / 10^n.
        let halvings = bitsPerDigit * fractionDigits
        var five = ExactInteger.one
        for _ in 0..<halvings { five = five * ExactInteger(5) }
        var value = DecimalJS(normalizing: (negative ? -mantissa : mantissa) * five, exponent: -halvings)
        guard binaryExponent != 0 else { return .finite(value) }
        if Swift.abs(binaryExponent) < 54 {
            // `x.times(Math.pow(2, p))` with every digit kept; the factor is the double's text.
            guard let factor = try? DecimalJS(Foundation.pow(2, Double(binaryExponent))) else { return .invalid }
            value = value.exactTimes(factor)
            return .finite(value)
        }
        // `Decimal.pow(2, p)`: a power beyond the exponent range is an infinity or zero.
        let rangeLimit = 29_000_000_000_000_000
        if binaryExponent > rangeLimit { return .infinity(negative: negative) }
        if binaryExponent < -rangeLimit { return .finite(.zero) }
        let power = integerPower(DecimalJS(2), Swift.abs(binaryExponent))
        guard let factor = binaryExponent < 0 ? try? DecimalJS.one.dividedBy(power) : power.roundedToPrecision else {
            return .invalid
        }
        return .finite(value.times(factor))
    }

    /// `toString()`: plain notation, or exponent notation when the leading exponent is at
    /// most -7 or at least 21 (`toExpNeg`, `toExpPos`).
    var javaScriptString: String {
        let leading = leadingExponent
        guard !coefficient.isZero, leading <= -7 || leading >= 21 else { return toFixed }
        let digits = coefficient.magnitudeDigits
        var text = coefficient.signum < 0 ? "-" : ""
        text += String(digits.prefix(1))
        if digits.count > 1 { text += "." + String(digits.dropFirst()) }
        return text + (leading < 0 ? "e" : "e+") + String(leading)
    }

    // MARK: Sums and order

    /// `Decimal.sum(...values)`: added with every digit kept, rounded once.
    static func sum(_ values: [DecimalJS]) -> DecimalJS {
        guard let first = values.first else { return .zero }
        var coefficient = first.coefficient
        var exponent = first.exponent
        for value in values.dropFirst() {
            let shared = Swift.min(exponent, value.exponent)
            coefficient =
                coefficient.timesPow10(exponent - shared) + value.coefficient.timesPow10(value.exponent - shared)
            exponent = shared
        }
        return finalised(coefficient, exponent)
    }

    static func min(_ a: DecimalJS, _ b: DecimalJS) -> DecimalJS { a.gt(b) ? b : a }

    // MARK: Powers

    /// `truncate(x.d, words)`: `decimal.js` holds digits in words of seven, aligned to the
    /// decimal point, and drops the words past `words`. Returns the kept value unnormalized,
    /// whether anything was dropped, and whether the last kept word is zero.
    private static func truncated(_ value: DecimalJS, words: Int) -> (
        coefficient: ExactInteger, exponent: Int, dropped: Bool, lastWordZero: Bool
    ) {
        let wordDigits = 7
        let digits = value.coefficient.digitCount
        guard digits > 0 else { return (value.coefficient, value.exponent, false, false) }
        let leading = value.exponent + digits - 1
        let firstWord = ((leading % wordDigits) + wordDigits) % wordDigits + 1
        let held = 1 + (Swift.max(0, digits - firstWord) + wordDigits - 1) / wordDigits
        guard held > words else { return (value.coefficient, value.exponent, false, false) }
        let drop = digits - (firstWord + (words - 1) * wordDigits)
        let kept = value.coefficient.magnitude / ExactInteger.pow10(drop)
        let lastWordZero = (kept % ExactInteger.pow10(wordDigits)).isZero
        return (value.coefficient.signum < 0 ? -kept : kept, value.exponent + drop, true, lastWordZero)
    }

    /// `intPow(Ctor, x, n, precision)`: exponentiation by squaring on truncated words. The
    /// result is not rounded to the precision.
    static func integerPower(_ base: DecimalJS, _ power: Int) -> DecimalJS {
        // `Math.ceil(pr / LOG_BASE + 4)` words.
        let words = (precision + 6) / 7 + 4
        var result = DecimalJS.one
        var square = base
        var remaining = power
        while true {
            if remaining % 2 == 1 {
                let product = truncated(result.exactTimes(square), words: words)
                remaining /= 2
                if remaining == 0 {
                    // "To ensure correct rounding when r.d is truncated, increment the last word
                    // if it is zero."
                    let sticky = product.dropped && product.lastWordZero
                    let unit = product.coefficient.signum < 0 ? -ExactInteger.one : ExactInteger.one
                    return DecimalJS(
                        normalizing: sticky ? product.coefficient + unit : product.coefficient,
                        exponent: product.exponent)
                }
                result = DecimalJS(normalizing: product.coefficient, exponent: product.exponent)
            } else {
                remaining /= 2
                if remaining == 0 { return result }
            }
            let squared = truncated(square.exactTimes(square), words: words)
            square = DecimalJS(normalizing: squared.coefficient, exponent: squared.exponent)
        }
    }

    /// `pow(y)` for the cases the ported callers reach: any base with a whole exponent, or a
    /// positive base with any exponent. Anything else (`NaN` or an infinity in `decimal.js`)
    /// throws.
    func pow(_ power: DecimalJS) throws -> DecimalJS {
        if isZero || power.isZero {
            // `Math.pow(+x, +y)`
            if power.isZero { return .one }
            guard power.coefficient.signum > 0 else { throw DecimalJSError(input: "\(self) ** \(power)") }
            return .zero
        }
        if eq(.one) { return self }
        if power.eq(.one) { return roundedToPrecision }
        if power.exponent >= 0, power.leadingExponent <= 15,
            let whole = power.coefficient.timesPow10(power.exponent).magnitude.int64Value,
            whole <= Int64(Self.maximumSafeInteger)
        {
            let raised = Self.integerPower(self, Int(whole))
            return power.coefficient.signum < 0 ? try DecimalJS.one.dividedBy(raised) : raised.roundedToPrecision
        }
        guard coefficient.signum > 0 else { throw DecimalJSError(input: "\(self) ** \(power)") }
        // exp(y × ln x), which `decimal.js` rounds correctly but for ties it cannot reach.
        return FixedPoint.exponential(FixedPoint.scaled(power, times: FixedPoint.naturalLogarithm(self)))
    }

    /// `sqrt()` of a value that is not negative, correctly rounded.
    var squareRoot: DecimalJS {
        guard coefficient.signum > 0 else { return .zero }
        var shift = Swift.max(0, 2 * (Self.precision + 2) - coefficient.digitCount)
        if (exponent - shift) % 2 != 0 { shift += 1 }
        let radicand = coefficient.timesPow10(shift)
        let root = FixedPoint.integerSquareRoot(radicand)
        return Self.finalised(root, (exponent - shift) / 2, inexact: root * root != radicand)
    }

    /// Fixed-point arithmetic at 80 decimal places for `exp` and `ln`: 50 guard digits beyond
    /// the 30 a result keeps.
    private enum FixedPoint {
        static let places = 80
        static let one = ExactInteger.pow10(places)
        static let ln10: ExactInteger = {
            // ln 10 = 3 ln 2 + ln 1.25, with ln((n + 1) / (n - 1)) = 2 atanh(1 / n).
            ExactInteger(6) * inverseHyperbolicTangent(reciprocalOf: 3)
                + ExactInteger(2) * inverseHyperbolicTangent(reciprocalOf: 9)
        }()

        static func multiply(_ a: ExactInteger, _ b: ExactInteger) -> ExactInteger { a * b / one }

        /// atanh(1 / n) = Σ 1 / ((2i + 1) n^(2i + 1)).
        static func inverseHyperbolicTangent(reciprocalOf n: Int) -> ExactInteger {
            let divisor = ExactInteger(n * n)
            var power = one / ExactInteger(n)
            var sum = ExactInteger.zero
            var odd = 1
            while !power.isZero {
                sum = sum + power / ExactInteger(odd)
                power = power / divisor
                odd += 2
            }
            return sum
        }

        /// ln x for x > 0.
        static func naturalLogarithm(_ x: DecimalJS) -> ExactInteger {
            let digits = x.coefficient.digitCount
            var tens = x.exponent + digits - 1
            // The significand in [1, 10), then in [0.32, 3.2) so the series converges quickly.
            var significand =
                digits - 1 <= places
                ? x.coefficient.timesPow10(places - (digits - 1))
                : x.coefficient / ExactInteger.pow10(digits - 1 - places)
            if significand > ExactInteger(32).timesPow10(places - 1) {
                significand = significand / ExactInteger(10)
                tens += 1
            }
            // ln m = 2 atanh((m - 1) / (m + 1))
            let ratio = (significand - one) * one / (significand + one)
            let square = multiply(ratio, ratio)
            var power = ratio
            var sum = ExactInteger.zero
            var odd = 1
            while !power.isZero {
                sum = sum + power / ExactInteger(odd)
                power = multiply(power, square)
                odd += 2
            }
            return ExactInteger(2) * sum + ExactInteger(tens) * ln10
        }

        /// `factor × value` for a fixed-point `value`.
        static func scaled(_ factor: DecimalJS, times value: ExactInteger) -> ExactInteger {
            let product = factor.coefficient * value
            return factor.exponent >= 0
                ? product.timesPow10(factor.exponent) : product / ExactInteger.pow10(-factor.exponent)
        }

        /// e^t rounded to the precision.
        static func exponential(_ t: ExactInteger) -> DecimalJS {
            // t = tens × ln 10 + rest with rest in [0, ln 10).
            var (tens, rest) = t.quotientAndRemainder(dividingBy: ln10)
            if rest.signum < 0 {
                tens = tens - .one
                rest = rest + ln10
            }
            // e^rest = (e^(rest / 2^halvings))^(2^halvings), the inner one by its Taylor series.
            let halvings = 10
            let reduced = rest / ExactInteger(1 << halvings)
            var term = one
            var sum = one
            var index = 1
            while !term.isZero {
                term = multiply(term, reduced) / ExactInteger(index)
                sum = sum + term
                index += 1
            }
            for _ in 0..<halvings { sum = multiply(sum, sum) }
            let exponent = Int(tens.int64Value ?? 0) - places
            return DecimalJS.finalised(sum, exponent, inexact: true)
        }

        /// ⌊√n⌋ by Newton's iteration from above.
        static func integerSquareRoot(_ n: ExactInteger) -> ExactInteger {
            guard n.signum > 0 else { return .zero }
            var estimate = ExactInteger.pow10((n.digitCount + 1) / 2)
            while true {
                let next = (estimate + n / estimate) / ExactInteger(2)
                if next >= estimate { return estimate }
                estimate = next
            }
        }
    }
}
