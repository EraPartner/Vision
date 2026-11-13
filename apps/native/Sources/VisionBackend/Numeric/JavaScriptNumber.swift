import Foundation

/// The JavaScript number operations the TypeScript backend's output depends on and Swift
/// spells differently: `Number.prototype.toFixed`, `toPrecision` and `Math.round`. Each rounds
/// the double's exact binary value, as ECMA-262 requires, not its shortest decimal form.
extension JavaScriptNumber {
    /// `String(number)`.
    static func text(_ number: Double) -> String { SQLArguments.javaScriptText(number) }

    /// `Math.round(number)`: the nearest integer, a tie going towards positive infinity.
    static func round(_ number: Double) -> Double {
        guard number.isFinite else { return number }
        let floor = number.rounded(.down)
        return number - floor >= 0.5 ? floor + 1 : floor
    }

    private static func powerOfTwo(_ exponent: Int) -> ExactInteger {
        var result = ExactInteger.one
        var remaining = exponent
        let chunk = ExactInteger(Int64(1) << 30)
        while remaining >= 30 {
            result = result * chunk
            remaining -= 30
        }
        return result * ExactInteger(Int64(1) << Int64(remaining))
    }

    /// A positive finite double as the exact fraction `numerator / denominator`.
    private static func fraction(_ magnitude: Double) -> (numerator: ExactInteger, denominator: ExactInteger) {
        // significand is in [1, 2) with at most 52 fraction bits, so this product is an integer.
        let mantissa = ExactInteger(Int64(magnitude.significand * 4_503_599_627_370_496))
        let exponent = Int(magnitude.exponent) - 52
        return exponent >= 0 ? (mantissa * powerOfTwo(exponent), .one) : (mantissa, powerOfTwo(-exponent))
    }

    /// The integer nearest `magnitude × 10^power`, a tie going up ("pick the larger n").
    private static func scaled(_ magnitude: Double, byTenTo power: Int) -> ExactInteger {
        var (numerator, denominator) = fraction(magnitude)
        if power >= 0 { numerator = numerator.timesPow10(power) } else { denominator = denominator.timesPow10(-power) }
        let two = ExactInteger(2)
        return (numerator * two + denominator) / (denominator * two)
    }

    /// `floor(log10(magnitude))`, exactly.
    private static func decimalExponent(_ magnitude: Double) -> Int {
        let (numerator, denominator) = fraction(magnitude)
        // numerator / denominator >= 10^k
        func reaches(_ k: Int) -> Bool {
            k >= 0 ? !(numerator < denominator.timesPow10(k)) : !(numerator.timesPow10(-k) < denominator)
        }
        var exponent = Int(log10(magnitude).rounded(.down))
        while !reaches(exponent) { exponent -= 1 }
        while reaches(exponent + 1) { exponent += 1 }
        return exponent
    }

    private static func zeros(_ count: Int) -> String { String(repeating: "0", count: Swift.max(0, count)) }

    /// `number.toFixed(digits)`, for `digits` in 0...100.
    static func toFixed(_ number: Double, _ digits: Int = 0) -> String {
        guard number.isFinite, number.magnitude < 1e21 else { return text(number) }
        guard number != 0 else { return digits > 0 ? "0." + zeros(digits) : "0" }
        var body = scaled(number.magnitude, byTenTo: digits).magnitudeDigits
        if digits > 0 {
            body = zeros(digits + 1 - body.count) + body
            let point = body.index(body.endIndex, offsetBy: -digits)
            body = body[..<point] + "." + body[point...]
        }
        return (number < 0 ? "-" : "") + body
    }

    /// `number.toPrecision(precision)`, for `precision` in 1...100.
    static func toPrecision(_ number: Double, _ precision: Int) -> String {
        guard number.isFinite else { return text(number) }
        guard number != 0 else { return precision > 1 ? "0." + zeros(precision - 1) : "0" }
        var exponent = decimalExponent(number.magnitude)
        var digits = scaled(number.magnitude, byTenTo: precision - 1 - exponent).magnitudeDigits
        if digits.count > precision {
            // Rounded up to the next power of ten.
            digits.removeLast()
            exponent += 1
        }
        let sign = number < 0 ? "-" : ""
        if exponent < -6 || exponent >= precision {
            let first = digits.prefix(1)
            let rest = digits.dropFirst()
            let mantissa = rest.isEmpty ? String(first) : first + "." + rest
            return sign + mantissa + "e" + (exponent < 0 ? "-" : "+") + String(exponent.magnitude)
        }
        if exponent == precision - 1 { return sign + digits }
        if exponent >= 0 {
            let point = digits.index(digits.startIndex, offsetBy: exponent + 1)
            return sign + digits[..<point] + "." + digits[point...]
        }
        return sign + "0." + zeros(-(exponent + 1)) + digits
    }
}
