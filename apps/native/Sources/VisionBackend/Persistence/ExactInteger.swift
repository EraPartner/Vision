/// An arbitrary-precision signed integer: the coefficient of an exact decimal (ADR-270), in
/// place of the JavaScript `BigInt` that `numeric.ts` uses. No dependency: base-10⁹ limbs, so
/// decimal text, digit counts and powers of ten stay cheap. Division truncates toward zero
/// and the remainder takes the dividend's sign, as `BigInt` `/` and `%` do.
public struct ExactInteger: Sendable, Hashable, Comparable, CustomStringConvertible {
    static let base: UInt64 = 1_000_000_000
    static let baseDigits = 9

    /// Little-endian limbs below `base`, without high zero limbs; zero has none.
    private(set) var limbs: [UInt32]
    /// Never set for zero.
    private(set) var isNegative: Bool

    public static let zero = ExactInteger(limbs: [], isNegative: false)
    public static let one = ExactInteger(1)

    init(limbs: [UInt32], isNegative: Bool) {
        var trimmed = limbs
        while let last = trimmed.last, last == 0 { trimmed.removeLast() }
        self.limbs = trimmed
        self.isNegative = trimmed.isEmpty ? false : isNegative
    }

    public init(_ value: Int64) {
        var magnitude = value.magnitude
        var limbs: [UInt32] = []
        while magnitude > 0 {
            limbs.append(UInt32(magnitude % Self.base))
            magnitude /= Self.base
        }
        self.init(limbs: limbs, isNegative: value < 0)
    }

    public init(_ value: Int) { self.init(Int64(value)) }

    /// Decimal digits only (no sign, no separators); `nil` for anything else or no digits.
    public init?(decimalDigits text: Substring) {
        guard !text.isEmpty, text.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }) else { return nil }
        let bytes = Array(text.utf8)
        var limbs: [UInt32] = []
        limbs.reserveCapacity(bytes.count / Self.baseDigits + 1)
        var end = bytes.count
        while end > 0 {
            let start = max(0, end - Self.baseDigits)
            var limb: UInt32 = 0
            for index in start..<end { limb = limb * 10 + UInt32(bytes[index] - 48) }
            limbs.append(limb)
            end = start
        }
        self.init(limbs: limbs, isNegative: false)
    }

    public var isZero: Bool { limbs.isEmpty }
    public var signum: Int { isZero ? 0 : (isNegative ? -1 : 1) }
    public var magnitude: ExactInteger { ExactInteger(limbs: limbs, isNegative: false) }

    /// Decimal digits of the magnitude (1 for zero), as `abs(n).toString().length`.
    public var digitCount: Int {
        guard let top = limbs.last else { return 1 }
        var digits = 0
        var value = top
        while value > 0 {
            digits += 1
            value /= 10
        }
        return (limbs.count - 1) * Self.baseDigits + digits
    }

    /// The decimal digits of the magnitude, without sign.
    public var magnitudeDigits: String {
        guard let top = limbs.last else { return "0" }
        var text = String(top)
        text.reserveCapacity(limbs.count * Self.baseDigits)
        for limb in limbs.dropLast().reversed() {
            let digits = String(limb)
            text += String(repeating: "0", count: Self.baseDigits - digits.count) + digits
        }
        return text
    }

    public var description: String { isNegative ? "-" + magnitudeDigits : magnitudeDigits }

    /// The value when it fits an `Int64`.
    public var int64Value: Int64? {
        guard limbs.count <= 3 else { return nil }
        var magnitude: UInt64 = 0
        for limb in limbs.reversed() {
            let (scaled, overflow) = magnitude.multipliedReportingOverflow(by: Self.base)
            guard !overflow else { return nil }
            let (sum, carry) = scaled.addingReportingOverflow(UInt64(limb))
            guard !carry else { return nil }
            magnitude = sum
        }
        if isNegative {
            if magnitude == UInt64(Int64.max) + 1 { return Int64.min }
            return magnitude <= UInt64(Int64.max) ? -Int64(magnitude) : nil
        }
        return magnitude <= UInt64(Int64.max) ? Int64(magnitude) : nil
    }

    /// The remainder of the magnitude by a small positive divisor.
    func magnitudeRemainder(dividingBy divisor: UInt32) -> UInt32 {
        Self.divideMagnitude(limbs, by: divisor).remainder
    }

    // MARK: Powers of ten

    private static let smallPowers: [UInt32] = [1, 10, 100, 1000, 10_000, 100_000, 1_000_000, 10_000_000, 100_000_000]

    public static func pow10(_ exponent: Int) -> ExactInteger {
        precondition(exponent >= 0, "negative power of ten: \(exponent)")
        return ExactInteger.one.timesPow10(exponent)
    }

    /// `self * 10^exponent` for `exponent >= 0`.
    public func timesPow10(_ exponent: Int) -> ExactInteger {
        precondition(exponent >= 0, "negative power of ten: \(exponent)")
        if isZero || exponent == 0 { return self }
        let wholeLimbs = exponent / Self.baseDigits
        let rest = exponent % Self.baseDigits
        var shifted = Array(repeating: UInt32(0), count: wholeLimbs) + limbs
        if rest > 0 { shifted = Self.multiplyMagnitude(shifted, by: Self.smallPowers[rest]) }
        return ExactInteger(limbs: shifted, isNegative: isNegative)
    }

    // MARK: Arithmetic

    public static prefix func - (value: ExactInteger) -> ExactInteger {
        ExactInteger(limbs: value.limbs, isNegative: !value.isNegative)
    }

    public static func + (lhs: ExactInteger, rhs: ExactInteger) -> ExactInteger {
        if lhs.isNegative == rhs.isNegative {
            return ExactInteger(limbs: addMagnitudes(lhs.limbs, rhs.limbs), isNegative: lhs.isNegative)
        }
        switch compareMagnitudes(lhs.limbs, rhs.limbs) {
        case 0: return .zero
        case 1: return ExactInteger(limbs: subtractMagnitudes(lhs.limbs, rhs.limbs), isNegative: lhs.isNegative)
        default: return ExactInteger(limbs: subtractMagnitudes(rhs.limbs, lhs.limbs), isNegative: rhs.isNegative)
        }
    }

    public static func - (lhs: ExactInteger, rhs: ExactInteger) -> ExactInteger { lhs + -rhs }

    public static func * (lhs: ExactInteger, rhs: ExactInteger) -> ExactInteger {
        if lhs.isZero || rhs.isZero { return .zero }
        let a = lhs.limbs
        let b = rhs.limbs
        var result = Array(repeating: UInt64(0), count: a.count + b.count)
        for i in 0..<a.count {
            var carry: UInt64 = 0
            let x = UInt64(a[i])
            if x == 0 { continue }
            for j in 0..<b.count {
                let total = result[i + j] + x * UInt64(b[j]) + carry
                result[i + j] = total % base
                carry = total / base
            }
            var k = i + b.count
            while carry > 0 {
                let total = result[k] + carry
                result[k] = total % base
                carry = total / base
                k += 1
            }
        }
        return ExactInteger(limbs: result.map { UInt32($0) }, isNegative: lhs.isNegative != rhs.isNegative)
    }

    /// Truncating division: the quotient rounds toward zero, the remainder has the dividend's sign.
    public func quotientAndRemainder(dividingBy divisor: ExactInteger) -> (quotient: ExactInteger, remainder: ExactInteger) {
        precondition(!divisor.isZero, "division by zero")
        if Self.compareMagnitudes(limbs, divisor.limbs) < 0 { return (.zero, self) }
        let quotient: [UInt32]
        let remainder: [UInt32]
        if divisor.limbs.count == 1 {
            let result = Self.divideMagnitude(limbs, by: divisor.limbs[0])
            quotient = result.quotient
            remainder = result.remainder == 0 ? [] : [result.remainder]
        } else {
            (quotient, remainder) = Self.longDivide(limbs, divisor.limbs)
        }
        return (
            ExactInteger(limbs: quotient, isNegative: isNegative != divisor.isNegative),
            ExactInteger(limbs: remainder, isNegative: isNegative)
        )
    }

    public static func / (lhs: ExactInteger, rhs: ExactInteger) -> ExactInteger {
        lhs.quotientAndRemainder(dividingBy: rhs).quotient
    }

    public static func % (lhs: ExactInteger, rhs: ExactInteger) -> ExactInteger {
        lhs.quotientAndRemainder(dividingBy: rhs).remainder
    }

    public static func < (lhs: ExactInteger, rhs: ExactInteger) -> Bool {
        if lhs.isNegative != rhs.isNegative { return lhs.isNegative }
        let order = compareMagnitudes(lhs.limbs, rhs.limbs)
        return lhs.isNegative ? order > 0 : order < 0
    }

    // MARK: Magnitudes

    static func compareMagnitudes(_ a: [UInt32], _ b: [UInt32]) -> Int {
        if a.count != b.count { return a.count < b.count ? -1 : 1 }
        var index = a.count - 1
        while index >= 0 {
            if a[index] != b[index] { return a[index] < b[index] ? -1 : 1 }
            index -= 1
        }
        return 0
    }

    private static func addMagnitudes(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        let (long, short) = a.count >= b.count ? (a, b) : (b, a)
        var result: [UInt32] = []
        result.reserveCapacity(long.count + 1)
        var carry: UInt64 = 0
        for index in 0..<long.count {
            let total = UInt64(long[index]) + (index < short.count ? UInt64(short[index]) : 0) + carry
            result.append(UInt32(total % base))
            carry = total / base
        }
        if carry > 0 { result.append(UInt32(carry)) }
        return result
    }

    /// `a - b` for `a >= b`.
    private static func subtractMagnitudes(_ a: [UInt32], _ b: [UInt32]) -> [UInt32] {
        var result: [UInt32] = []
        result.reserveCapacity(a.count)
        var borrow: Int64 = 0
        for index in 0..<a.count {
            var difference = Int64(a[index]) - (index < b.count ? Int64(b[index]) : 0) - borrow
            if difference < 0 {
                difference += Int64(base)
                borrow = 1
            } else {
                borrow = 0
            }
            result.append(UInt32(difference))
        }
        return result
    }

    private static func multiplyMagnitude(_ a: [UInt32], by factor: UInt32) -> [UInt32] {
        var result: [UInt32] = []
        result.reserveCapacity(a.count + 1)
        var carry: UInt64 = 0
        for limb in a {
            let total = UInt64(limb) * UInt64(factor) + carry
            result.append(UInt32(total % base))
            carry = total / base
        }
        while carry > 0 {
            result.append(UInt32(carry % base))
            carry /= base
        }
        return result
    }

    private static func divideMagnitude(_ a: [UInt32], by divisor: UInt32) -> (quotient: [UInt32], remainder: UInt32) {
        var quotient = Array(repeating: UInt32(0), count: a.count)
        var remainder: UInt64 = 0
        var index = a.count - 1
        while index >= 0 {
            let current = remainder * base + UInt64(a[index])
            quotient[index] = UInt32(current / UInt64(divisor))
            remainder = current % UInt64(divisor)
            index -= 1
        }
        return (quotient, UInt32(remainder))
    }

    /// Knuth's algorithm D in base 10⁹, for a divisor of two or more limbs and `u >= v`.
    private static func longDivide(_ u: [UInt32], _ v: [UInt32]) -> (quotient: [UInt32], remainder: [UInt32]) {
        let n = v.count
        let m = u.count - n
        // Normalise so the divisor's top limb is at least base / 2.
        let factor = UInt32(base / (UInt64(v[n - 1]) + 1))
        var un = multiplyMagnitude(u, by: factor)
        if un.count == u.count { un.append(0) }
        var vn = multiplyMagnitude(v, by: factor)
        while vn.count > n { vn.removeLast() }
        let top = UInt64(vn[n - 1])
        let second = UInt64(vn[n - 2])
        var quotient = Array(repeating: UInt32(0), count: m + 1)
        var j = m
        while j >= 0 {
            let numerator = UInt64(un[j + n]) * base + UInt64(un[j + n - 1])
            var qhat = numerator / top
            var rhat = numerator % top
            while qhat >= base || qhat * second > rhat * base + UInt64(un[j + n - 2]) {
                qhat -= 1
                rhat += top
                if rhat >= base { break }
            }
            // un[j...j+n] -= qhat * vn
            var borrow: Int64 = 0
            var carry: UInt64 = 0
            for i in 0..<n {
                let product = qhat * UInt64(vn[i]) + carry
                carry = product / base
                var difference = Int64(un[i + j]) - Int64(product % base) - borrow
                if difference < 0 {
                    difference += Int64(base)
                    borrow = 1
                } else {
                    borrow = 0
                }
                un[i + j] = UInt32(difference)
            }
            var difference = Int64(un[j + n]) - Int64(carry) - borrow
            if difference < 0 {
                // qhat was one too large: add the divisor back.
                difference += Int64(base)
                un[j + n] = UInt32(difference)
                qhat -= 1
                var addCarry: UInt64 = 0
                for i in 0..<n {
                    let total = UInt64(un[i + j]) + UInt64(vn[i]) + addCarry
                    un[i + j] = UInt32(total % base)
                    addCarry = total / base
                }
                un[j + n] = UInt32((UInt64(un[j + n]) + addCarry) % base)
            } else {
                un[j + n] = UInt32(difference)
            }
            quotient[j] = UInt32(qhat)
            j -= 1
        }
        let remainder = divideMagnitude(Array(un[0..<n]), by: factor).quotient
        return (quotient, remainder)
    }
}
