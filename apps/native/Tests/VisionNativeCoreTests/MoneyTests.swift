import Foundation
import Testing

@testable import VisionNativeCore

/// `packages/shared-utils/tests/money.test.ts`, case for case.
@Suite struct MoneyTests {
    @Test func sumAddsAmountsInOneCurrencyExactly() throws {
        let tenth = try #require(Decimal(string: "0.1"))
        let fifth = try #require(Decimal(string: "0.2"))
        let total = try Money.sum([Money(tenth, "EUR"), Money(fifth, "EUR")], currency: "EUR")
        #expect(total.amount == Decimal(string: "0.3"))
        #expect(total.amount.description == "0.3")
        #expect(total.currency == "EUR")
    }

    @Test func sumOfNothingIsZeroInTheRequestedCurrency() throws {
        let total = try Money.sum([], currency: "USD")
        #expect(total.amount.isZero)
        #expect(total.currency == "USD")
    }

    @Test func sumRefusesToAddADifferentCurrency() {
        #expect(throws: CurrencyMismatchError.self) {
            try Money.sum([Money(10, "EUR"), Money(10, "USD")], currency: "EUR")
        }
        #expect(throws: CurrencyMismatchError.self) {
            try Money(1, "USD").adding(Money(1, "EUR"))
        }
    }

    @Test func theMismatchNamesBothCurrencies() {
        do {
            _ = try Money.sum([Money(10, "USD")], currency: "EUR")
            Issue.record("expected a mismatch")
        } catch let error as CurrencyMismatchError {
            #expect(error.expected == "EUR")
            #expect(error.actual == "USD")
            #expect(error.description == "Cannot combine USD with EUR without converting")
        } catch {
            Issue.record("unexpected error \(error)")
        }
    }

    @Test func addingKeepsTheCurrency() throws {
        let sum = try Money(Decimal(string: "1.25") ?? 0, "CHF").adding(Money(Decimal(string: "2.5") ?? 0, "CHF"))
        #expect(sum == Money(Decimal(string: "3.75") ?? 0, "CHF"))
    }

    @Test func aCurrencyCodeStillRejectsMalformedText() {
        #expect(CurrencyCode(rawValue: "eur") == nil)
        #expect(CurrencyCode(rawValue: "EURO") == nil)
    }
}
