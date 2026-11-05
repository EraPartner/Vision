import Foundation
import Testing

@testable import VisionNativeCore

@Suite struct VisionFormatChartTests {
    private func normalised(_ text: String) -> String {
        text.replacingOccurrences(of: "\u{00A0}", with: " ").replacingOccurrences(of: "\u{202F}", with: " ")
    }

    @Test func axisAmountsAboveAThousandScaleToKWithTheLocalesSymbolOrder() {
        let german = Locale(identifier: "de_DE")
        #expect(normalised(VisionFormat.currencyAxisCompact(6_500, code: .eur, locale: german)) == "6,5k €")
        #expect(normalised(VisionFormat.currencyAxisCompact(3_000, code: .eur, locale: german)) == "3k €")
        #expect(normalised(VisionFormat.currencyAxisCompact(-1_500, code: .eur, locale: german)) == "-1,5k €")
        #expect(normalised(VisionFormat.currencyAxisCompact(2_400_000, code: .eur, locale: german)) == "2,4M €")
    }

    @Test func cachedCurrencyStylesKeepEachLocaleDigitCountAndSignApart() {
        let german = Locale(identifier: "de_DE")
        let american = Locale(identifier: "en_US")
        for _ in 0..<2 {
            #expect(normalised(VisionFormat.currency(1234.5, code: .eur, locale: german, fractionDigits: 2)) == "1.234,50 €")
            #expect(VisionFormat.currency(1234.5, code: .eur, locale: american, fractionDigits: 2) == "€1,234.50")
            #expect(VisionFormat.currency(1234.5, code: .eur, locale: american, fractionDigits: 0) == "€1,235")
            #expect(VisionFormat.currency(1234.5, code: .eur, locale: american, fractionDigits: 2, signed: true) == "+€1,234.50")
            #expect(VisionFormat.currency(0, code: .eur, locale: american, fractionDigits: 2, signed: true) == "€0.00")
            #expect(VisionFormat.currency(1234.5, code: "USD", locale: american, fractionDigits: 2) == "$1,234.50")
        }
    }

    @Test func axisAmountsUnderAThousandKeepNoFractionDigits() {
        let german = Locale(identifier: "de_DE")
        #expect(normalised(VisionFormat.currencyAxisCompact(0, code: .eur, locale: german)) == "0 €")
        #expect(normalised(VisionFormat.currencyAxisCompact(250, code: .eur, locale: german)) == "250 €")
    }

    @Test func axisSuffixFollowsTheLastDigitInCurrencyFirstLocales() {
        let american = Locale(identifier: "en_US")
        #expect(VisionFormat.currencyAxisCompact(6_500, code: .eur, locale: american) == "€6.5k")
    }

    @Test func monthYearFollowsTheAppDateFormat() {
        #expect(VisionFormat.monthYear(year: 2026, month: 5, format: .dayMonthYearSlash) == "05/2026")
        #expect(VisionFormat.monthYear(year: 2026, month: 5, format: .monthDayYearSlash) == "05/2026")
        #expect(VisionFormat.monthYear(year: 2026, month: 5, format: .isoDate) == "2026-05")
        #expect(VisionFormat.monthYear(year: 2026, month: 5, format: .dayMonthYearDot) == "05.2026")
        #expect(VisionFormat.monthYear(year: 2026, month: 5, format: .dayMonthYearDash) == "05-2026")
    }
}
