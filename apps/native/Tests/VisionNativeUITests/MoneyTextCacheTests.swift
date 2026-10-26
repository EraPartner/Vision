import Foundation
import Testing
import VisionNativeCore
@testable import VisionNativeUI

@MainActor
@Suite struct MoneyTextCacheTests {
    private let euro = ReportingFallbackCurrency.euro

    @Test func aRepeatedAmountIsFormattedOnce() {
        let cache = MoneyTextCache()
        let locale = Locale(identifier: "en_US")
        let amount = Decimal(string: "1234.5") ?? 0
        let first = cache.text(amount, currency: euro, locale: locale, fractionDigits: 2, signed: false)
        let again = cache.text(amount, currency: euro, locale: locale, fractionDigits: 2, signed: false)
        #expect(first == again)
        #expect(cache.misses == 1)
    }

    @Test func signLocaleAndDigitsKeyTheText() {
        let cache = MoneyTextCache()
        let amount = Decimal(string: "7") ?? 0
        let us = Locale(identifier: "en_US")
        let nl = Locale(identifier: "nl_NL")
        let plain = cache.text(amount, currency: euro, locale: us, fractionDigits: 2, signed: false)
        let signed = cache.text(amount, currency: euro, locale: us, fractionDigits: 2, signed: true)
        let dutch = cache.text(amount, currency: euro, locale: nl, fractionDigits: 2, signed: false)
        let whole = cache.text(amount, currency: euro, locale: us, fractionDigits: 0, signed: false)
        #expect(cache.misses == 4)
        #expect(plain == VisionFormat.currency(amount, code: euro, locale: us, fractionDigits: 2))
        #expect(signed == VisionFormat.currency(amount, code: euro, locale: us, fractionDigits: 2, signed: true))
        #expect(dutch == VisionFormat.currency(amount, code: euro, locale: nl, fractionDigits: 2))
        #expect(whole == VisionFormat.currency(amount, code: euro, locale: us, fractionDigits: 0))
    }
}
