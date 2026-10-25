import Foundation
import Testing

@testable import VisionNativeCore

/// Expectations come from `lib/__tests__/commandPalette.test.ts`,
/// `lib/__tests__/nativePaletteAnswer.test.ts` and the source evaluator's output for the
/// JavaScript edge cases (comma operator, comments, `.5`, `**` and calls).
@Suite struct NativePaletteCalculatorTests {
    private func rates(_ values: [String: Decimal], fallback: [String: Decimal] = [:]) -> OpenAPI.ExchangeRates {
        OpenAPI.ExchangeRates(
            totalRates: values.count,
            rates: values.map {
                OpenAPI.ExchangeRate(
                    currency: $0.key, rateToEur: $0.value, rateDate: "2026-01-01", fetchedAt: "2026-01-01T00:00:00Z")
            },
            fallbackRates: fallback, source: "database", isStale: false)
    }

    /// `Intl` and Foundation put a no-break space before a trailing symbol.
    private func plain(_ text: String?) -> String? {
        text?.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    @Test func fxQueriesParseLocaleAmountsAndOptionalTargets() {
        #expect(NativePaletteCalculator.parseFX("12.5 usd", format: .us) == .init(amount: 12.5, from: "USD", to: nil))
        #expect(
            NativePaletteCalculator.parseFX("12,5 eur naar gbp", format: .eu)
                == .init(amount: 12.5, from: "EUR", to: "GBP"))
        #expect(NativePaletteCalculator.parseFX("1.234 EUR", format: .eu)?.amount == 1234)
        #expect(NativePaletteCalculator.parseFX("1.234 EUR", format: .us)?.amount == 1.234)
        #expect(NativePaletteCalculator.parseFX("3 EUR to USD", format: .eu)?.to == "USD")
        #expect(NativePaletteCalculator.parseFX("3eur in usd", format: .us) == .init(amount: 3, from: "EUR", to: "USD"))
        for query in [" 3 EUR ", "EUR 3", "3 EURO", "3 EUR to US"] {
            #expect(NativePaletteCalculator.parseFX(query, format: .eu) == nil)
        }
    }

    @Test(arguments: [
        ("2 * (3 + 4)", NumberFormat.eu, 14.0), ("1,5 + 2", .eu, 3.5), ("1.234 + 2,5", .eu, 1236.5),
        ("1,234.5 + 2", .us, 1236.5), ("2**3", .eu, 8), ("2 , 3 + 1", .us, 4), ("2/**/+1", .us, 3),
        (".5+1", .us, 1.5), (".5+1", .eu, 1.5), ("2**-2", .us, 0.25), ("(-2)**2", .us, 4), ("2**3**2", .us, 512),
        ("- -2+1", .us, 3), ("2- -3", .us, 5), ("+-2*3", .us, -6), ("1'234.5 + 2", .ch, 1236.5),
        ("1,23,456 + 2", .in, 123_458), ("10/4", .eu, 2.5), ("-(2+3)", .us, -5), ("2 ** 0.5", .us, 2.0.squareRoot()),
    ])
    func arithmeticMatchesTheSourceEvaluator(query: String, format: NumberFormat, expected: Double) {
        #expect(NativePaletteCalculator.evaluate(query, format: format) == expected)
    }

    @Test(arguments: [
        "42", "2 +", "1 / 0", "-2**2", "--2+1", "2--3", "2(3)+1", "(2)(3)+1", "2 3+1", "2//3", "2**-2**2",
        "(1,2)+3", "2 *", "()+1", "1e3+1", "2* /3", "5.+1", "1 /* x */ + 2", "7 % 2", "(2", "2)", "NaN + 1",
        "process.exit()", "2; alert(1)",
    ])
    func invalidOrExecutableInputHasNoResult(query: String) {
        #expect(NativePaletteCalculator.evaluate(query, format: .us) == nil)
    }

    @Test func euDecimalsInTheUSFormatAreInvalidTokens() {
        #expect(NativePaletteCalculator.evaluate("1.5+1", format: .eu) == nil)
        #expect(NativePaletteCalculator.evaluate("0.1+0.2", format: .us) == 0.1 + 0.2)
    }

    @Test func arithmeticAnswersUseTheFormatsLocaleWithSixFractionDigits() async {
        func answer(_ query: String, _ format: NumberFormat) async -> String? {
            await NativePaletteCalculator.answer(
                query: query, format: format, currency: "EUR", decimals: 2, readRates: { nil })?.text
        }
        #expect(await answer(" 1.234 + 2,5 ", .eu) == "1.236,5")
        #expect(await answer("1,234.5 + 2", .us) == "1,236.5")
        #expect(["1'236.5", "1’236.5"].contains(await answer("1'234.5 + 2", .ch) ?? ""))
        #expect(await answer("1,23,456 + 2", .in) == "1,23,458")
        #expect(await answer("1 / 3", .us) == "0.333333")
        #expect(await answer("2**3", .eu) == "8")
        #expect(await answer("0 * -1", .us) == "-0")
    }

    @Test func conversionsPreferDatabaseRowsAndKeepAmountsWithoutRates() async {
        let data = rates(["USD": 0.5, "EUR": 2], fallback: ["USD": 0.9, "EUR": 0.1])
        let eur = await NativePaletteCalculator.answer(
            query: "12 USD", format: .us, currency: "EUR", decimals: 2, readRates: { data })
        #expect(eur == .init(kind: .fx, text: "€3.00"))
        let usd = await NativePaletteCalculator.answer(
            query: "12,5 eur naar usd", format: .eu, currency: "GBP", decimals: 0, readRates: { data })
        #expect(plain(usd?.text) == "50 $")
        let missing = await NativePaletteCalculator.answer(
            query: "5 USD to XYZ", format: .us, currency: "EUR", decimals: 2, readRates: { rates([:]) })
        #expect(plain(missing?.text) == "XYZ 5.00")
    }

    @Test func malformedCodesAndDigitCountsFallBackToTwoDecimalsAndTheCode() async {
        for (currency, decimals, text) in [("bad-code", 2, "5.00 bad-code"), ("EUR", 200, "5.00 EUR"), ("", 2, "5.00 ")] {
            let answer = await NativePaletteCalculator.answer(
                query: "5 USD", format: .us, currency: currency, decimals: decimals, readRates: { nil })
            #expect(answer == .init(kind: .fx, text: text))
        }
    }

    @Test func identicalCurrenciesSkipTheRateRead() async {
        let loads = PaletteRatesLoads()
        let same = await NativePaletteCalculator.answer(
            query: "5 EUR", format: .us, currency: "EUR", decimals: 2,
            readRates: {
                _ = try? await loads.next()
                return nil
            })
        #expect(same == nil)
        #expect(await loads.count == 0)
    }

    @Test func ratesStayFreshForTenMinutesAndSurviveAFailedRefetch() async {
        let clock = PaletteRatesClock()
        let loads = PaletteRatesLoads()
        let cache = NativePaletteRates(
            load: {
                let rate = try await loads.next()
                return OpenAPI.ExchangeRates(
                    totalRates: 1,
                    rates: [.init(currency: "USD", rateToEur: rate, rateDate: "d", fetchedAt: "f")],
                    fallbackRates: [:], source: "database", isStale: false)
            }, now: { clock.now })
        #expect(await cache.read()?.rates.first?.rateToEur == 1)
        clock.now = Date(timeIntervalSince1970: 600)
        #expect(await cache.read()?.rates.first?.rateToEur == 1)
        clock.now = Date(timeIntervalSince1970: 601)
        #expect(await cache.read()?.rates.first?.rateToEur == 2)
        await loads.failing(true)
        clock.now = Date(timeIntervalSince1970: 1300)
        #expect(await cache.read()?.rates.first?.rateToEur == 2)
        #expect(await loads.count == 3)
    }
}

private final class PaletteRatesClock: @unchecked Sendable {
    var now = Date(timeIntervalSince1970: 0)
}

private actor PaletteRatesLoads {
    var count = 0
    var fail = false
    func next() throws -> Decimal {
        count += 1
        if fail { throw APIError.network("offline") }
        return Decimal(count)
    }
    func failing(_ value: Bool) { fail = value }
}
