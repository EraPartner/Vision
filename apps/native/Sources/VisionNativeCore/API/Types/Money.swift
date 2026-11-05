import Foundation

/// An amount together with its currency (ADR-220), mirroring `Money` in
/// `packages/shared-utils/src/money.ts`. Totals that may span currencies take `Money`, not bare
/// decimals, so a caller has to say which currency every figure is in; `Money.sum` refuses a mix
/// instead of adding, for example, USD to EUR.
///
/// The wire keeps `amount` and `currency` as two separate fields (as in TypeScript), so this type
/// is for hand-written totals and is not part of the generated models.
public struct Money: Hashable, Sendable, CustomStringConvertible {
    public let amount: Decimal
    public let currency: CurrencyCode

    public init(amount: Decimal, currency: CurrencyCode) {
        self.amount = amount
        self.currency = currency
    }

    /// `money(amount, currency)` of the TypeScript module.
    public init(_ amount: Decimal, _ currency: CurrencyCode) {
        self.init(amount: amount, currency: currency)
    }

    /// The sum of `items`, all of which must already be in `currency` (`sumMoney`). Throws
    /// `CurrencyMismatchError` on any other currency: convert first. No items sum to zero.
    public static func sum(_ items: [Money], currency: CurrencyCode) throws -> Money {
        var total = Decimal.zero
        for item in items {
            guard item.currency == currency else {
                throw CurrencyMismatchError(expected: currency, actual: item.currency)
            }
            total += item.amount
        }
        return Money(amount: total, currency: currency)
    }

    /// `self` plus `other`, in `self`'s currency (`addMoney`); throws `CurrencyMismatchError`
    /// when `other` is in another currency.
    public func adding(_ other: Money) throws -> Money {
        try Money.sum([self, other], currency: currency)
    }

    public var description: String {
        "\(amount) \(currency.rawValue)"
    }
}

/// Two amounts in different currencies were combined without converting.
public struct CurrencyMismatchError: Error, Equatable, Sendable, CustomStringConvertible {
    public let expected: CurrencyCode
    public let actual: CurrencyCode

    public init(expected: CurrencyCode, actual: CurrencyCode) {
        self.expected = expected
        self.actual = actual
    }

    /// The TypeScript error's message.
    public var description: String {
        "Cannot combine \(actual.rawValue) with \(expected.rawValue) without converting"
    }
}
