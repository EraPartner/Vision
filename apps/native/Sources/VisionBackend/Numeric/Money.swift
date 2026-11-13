import Foundation
import VisionNativeCore

/// The money helpers of `packages/shared-utils/src/money.ts`: running sums go through the
/// decimal type and round once on emit, half to even.
///
/// `toDecimal(value)` is `DecimalJS.from(_:)` for text and `DecimalJS(_:)` for a number.
/// Unlike decimal.js, `DecimalJS` holds finite values only, so the text `Infinity` or `NaN`
/// throws here where `toDecimal` returns a non-finite decimal.
enum DecimalMoney {
    /// `addAll(values)`: the sum, rounded to the working precision after each addition.
    static func addAll(_ values: [DecimalJS]) -> DecimalJS {
        values.reduce(.zero) { $0.plus($1) }
    }

    /// `roundToCents(value)`.
    static func roundToCents(_ value: DecimalJS) -> DecimalJS { value.toDecimalPlaces(2, .halfEven) }

    /// `roundMoney(value, places)`: rounded half to even, as the nearest double.
    // lint:allow double-money the emit boundary: the TypeScript helper answers a JSON number
    static func roundMoney(_ value: DecimalJS, places: Int = 2) -> Double {
        value.toDecimalPlaces(places, .halfEven).toNumber
    }

    /// `numericColumn(value)`: a stored decimal as a number. SQL NULL stays `nil`; the empty
    /// string, which the TypeScript helper answers with `undefined`, is `nil` as well.
    // lint:allow double-money the read boundary: a stored decimal leaves as a JSON number
    static func numericColumn(_ text: String?) throws -> Double? {
        guard let text, !text.isEmpty else { return nil }
        return try DecimalJS(text).toNumber
    }
}

extension DecimalJS {
    /// `isInteger()`.
    var isInteger: Bool { exponent >= 0 }

    /// `toFixed(places, rounding)`: exactly `places` decimals. A negative value that rounds
    /// to zero keeps its sign, as decimal.js keeps the sign of zero.
    func toFixed(_ places: Int, _ rounding: Rounding = .halfEven) -> String {
        let rounded = toDecimalPlaces(places, rounding)
        var text = rounded.toFixed
        if rounded.isZero, coefficient.signum < 0 { text = "-" + text }
        guard places > 0 else { return text }
        let present = rounded.exponent < 0 ? -rounded.exponent : 0
        return text + (present == 0 ? "." : "") + String(repeating: "0", count: places - present)
    }
}

/// An amount together with its currency (`Money`, ADR-220), held in the backend's decimal type.
/// Totals that may span currencies take it, so a caller has to say which currency every figure
/// is in. A mix throws the core module's `CurrencyMismatchError`.
struct MoneyAmount: Equatable, Sendable {
    var amount: DecimalJS
    var currency: CurrencyCode

    /// `sumMoney(items, currency)`: the sum of `items`, all of which must be in `currency`.
    static func sum(_ items: [MoneyAmount], in currency: CurrencyCode) throws -> MoneyAmount {
        var total = DecimalJS.zero
        for item in items {
            if item.currency != currency { throw CurrencyMismatchError(expected: currency, actual: item.currency) }
            total = total.plus(item.amount)
        }
        return MoneyAmount(amount: total, currency: currency)
    }

    /// `addMoney(a, b)`.
    func adding(_ other: MoneyAmount) throws -> MoneyAmount { try MoneyAmount.sum([self, other], in: currency) }
}
