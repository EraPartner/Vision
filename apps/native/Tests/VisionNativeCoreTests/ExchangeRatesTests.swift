import Foundation
import Testing
@testable import VisionNativeCore

enum RatesFixture {
    static func rates(_ rows: [(CurrencyCode, String)] = [("USD", "1.0842"), ("CHF", "0.94")], total: Int = 1234)
        -> OpenAPI.ExchangeRates
    {
        OpenAPI.ExchangeRates(
            totalRates: total,
            rates: rows.map { currency, rate in
                OpenAPI.ExchangeRate(
                    currency: currency, rateToEur: Decimal(string: rate)!, rateDate: "2026-10-09",
                    fetchedAt: "2026-10-09T15:05:00.000Z")
            },
            source: .database, isStale: false, lastFetchedAt: "2026-10-09T15:05:00.000Z")
    }

    static let empty = OpenAPI.ExchangeRates(
        totalRates: 0, rates: [], source: .fallback, isStale: true, lastFetchedAt: nil)
}

/// A clock the test moves by hand.
final class TestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var current = Date(timeIntervalSinceReferenceDate: 0)

    var now: Date { lock.withLock { current } }
    func advance(_ seconds: TimeInterval) { lock.withLock { current += seconds } }
}

@MainActor
@Suite struct ExchangeRatesModelTests {
    @Test func loadsOnceAndRefetchesWhenStale() async {
        let service = FakeExchangeRatesService(rates: [.success(RatesFixture.rates()), .success(RatesFixture.empty)])
        let clock = TestClock()
        let model = ExchangeRatesModel(service: service, now: { clock.now })
        #expect(model.phase == .idle)
        #expect(model.isLoading && model.isRefreshDisabled)
        await model.appear()
        #expect(model.data == RatesFixture.rates())
        #expect(!model.isLoading && !model.isFetching && !model.isRefreshDisabled)
        clock.advance(9 * 60)
        await model.appear()
        #expect(await service.rateCalls == 1)
        clock.advance(2 * 60)
        await model.appear()
        #expect(await service.rateCalls == 2)
        #expect(model.data == RatesFixture.empty)
    }

    @Test func aFailedLoadShowsTheErrorAndRetryRecovers() async {
        let service = FakeExchangeRatesService(
            rates: [.failure(.timedOut), .success(RatesFixture.rates())])
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        #expect(model.phase == .failed)
        #expect(!model.isLoading)
        await model.retry()
        #expect(model.data == RatesFixture.rates())
    }

    @Test func aFailedRefetchReplacesTheData() async {
        // React Query keeps `error` set on a failed refetch, and the page checks it first.
        let service = FakeExchangeRatesService(rates: [.success(RatesFixture.rates()), .failure(.network("x"))])
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        await model.retry()
        #expect(model.phase == .failed)
    }

    @Test func refreshSuccessToastsAndRefetches() async {
        let service = FakeExchangeRatesService(
            rates: [.success(RatesFixture.empty), .success(RatesFixture.rates())],
            refreshes: [.success(OpenAPI.InfoMessage(message: "Exchange rates refreshed"))])
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        await model.refresh()
        #expect(model.notice?.kind == .success)
        #expect(model.notice?.key == "exchangeRates.refreshSuccess")
        #expect(model.data == RatesFixture.rates())
        #expect(!model.isRefreshing)
        #expect(await service.refreshCalls == 1)
        let id = model.notice?.id ?? -1
        model.clearNotice(id)
        #expect(model.notice == nil)
    }

    @Test func refreshFailureToastsAndKeepsTheData() async {
        let service = FakeExchangeRatesService(
            rates: [.success(RatesFixture.rates())],
            refreshes: [.failure(.client(APIClientError(status: 502, code: .badGateway, message: "ECB down")))])
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        await model.refresh()
        #expect(model.notice?.kind == .error)
        #expect(model.notice?.key == "exchangeRates.refreshError")
        #expect(model.data == RatesFixture.rates())
        #expect(await service.rateCalls == 1)
        #expect(!model.isRefreshPending)
    }
}

@Suite struct ExchangeRatesPresentationTests {
    let strings = DictionaryStrings(
        language: .en,
        table: [
            "exchangeRates.fetchedAt": "Fetched {date}",
            "exchangeRates.latestEcbDesc": "{count} currencies · ECB rate date {date}",
            "exchangeRates.noDataFetched": "No data fetched yet",
        ])
    let utc = TimeZone(identifier: "UTC")!

    @Test func summaryCardsAndLiveTableUseTheAppFormats() throws {
        let settings = NativeAppSettings(dateFormat: .dayMonthYearDot, numberFormat: .eu, showDecimalPlaces: 2)
        let view = ExchangeRatesPresentation(
            data: RatesFixture.rates(), settings: settings, strings: strings, timeZone: utc)
        #expect(view.cards.map(\.value) == ["1.234", "09.10.2026"])
        #expect(view.cards[1].subtext == "Fetched 09.10.2026 15:05")
        guard case .table(let table) = view.content else {
            Issue.record("expected a table")
            return
        }
        #expect(table.description == "2 currencies · ECB rate date 09.10.2026")
        let usd = try #require(table.rows.first)
        #expect(usd.currency == "USD")
        #expect(usd.rate == "1,084200")
        #expect(usd.inverse == "0,9223")
        // ICU and V8 both put a no-break space before the euro sign in de-DE.
        #expect(usd.hundredInEuro == "108,42\u{00A0}€")
        #expect(view.columns.count == 4)
    }

    @Test func withoutRatesThePageShowsTheEmptyState() {
        let view = ExchangeRatesPresentation(
            data: RatesFixture.empty, settings: .defaults, strings: strings, timeZone: utc)
        #expect(view.content == .empty(title: "exchangeRates.latestEcbRates", message: "exchangeRates.noRates"))
        #expect(view.cards.map(\.value) == ["0", "—"])
        #expect(view.cards[1].subtext == "No data fetched yet")
    }
}

@Suite struct VisionFormatTests {
    let utc = TimeZone(identifier: "UTC")!

    @Test func decimalsRoundHalfAwayFromZeroWithTheLocaleSeparators() {
        let de = NumberFormat.eu.locale
        let us = NumberFormat.us.locale
        #expect(VisionFormat.decimal(Decimal(string: "1234.56785")!, fractionDigits: 4, locale: us) == "1,234.5679")
        #expect(VisionFormat.decimal(Decimal(string: "1234.5")!, fractionDigits: 6, locale: de) == "1.234,500000")
        #expect(VisionFormat.decimal(Decimal(string: "-0.00005")!, fractionDigits: 4, locale: us) == "-0.0001")
        #expect(VisionFormat.integer(1_234_567, locale: NumberFormat.in.locale) == "12,34,567")
    }

    @Test func inverseOfZeroIsInfinity() {
        #expect(VisionFormat.inverse(0, fractionDigits: 4, locale: NumberFormat.us.locale) == "∞")
        #expect(VisionFormat.inverse(4, fractionDigits: 4, locale: NumberFormat.us.locale) == "0.2500")
    }

    @Test func currencyUsesFixedDigitsAndDegradesOutsideTheRange() {
        #expect(VisionFormat.currency(1234.5, code: "EUR", locale: NumberFormat.us.locale, fractionDigits: 2) == "€1,234.50")
        #expect(VisionFormat.currency(12, code: "EUR", locale: NumberFormat.us.locale, fractionDigits: 21) == "12")
    }

    @Test func appDatesFollowTheFiveFormats() {
        let expected: [AppDateFormat: String] = [
            .dayMonthYearSlash: "09/10/2026", .monthDayYearSlash: "10/09/2026", .isoDate: "2026-10-09",
            .dayMonthYearDot: "09.10.2026", .dayMonthYearDash: "09-10-2026",
        ]
        for (format, text) in expected {
            #expect(VisionFormat.appDate("2026-10-09", format: format, timeZone: utc) == text)
            #expect(VisionFormat.appDate("2026-10-09T23:30:00Z", format: format, timeZone: utc) == text)
        }
        #expect(VisionFormat.appDate("", format: .isoDate) == "")
        #expect(VisionFormat.appDate("not a date", format: .isoDate) == "not a date")
    }

    @Test func timestampsUseTheLocalDayAndATwoDigitTime() {
        let amsterdam = TimeZone(identifier: "Europe/Amsterdam")!
        // 23:30 UTC is the next day in Amsterdam (CEST, UTC+2).
        let text = VisionFormat.appDateTime(
            "2026-10-09T23:30:00.000Z", format: .isoDate, locale: NumberFormat.eu.locale, timeZone: amsterdam)
        #expect(text == "2026-10-10 01:30")
        let us = VisionFormat.appDateTime(
            "2026-10-09T08:05:00Z", format: .monthDayYearSlash, locale: NumberFormat.us.locale, timeZone: utc)
        #expect(us.hasPrefix("10/09/2026 08:05"))
        #expect(us.hasSuffix("AM"))
        #expect(VisionFormat.parseTimestamp("2026-10-09T08:05:00+02:00") != nil)
        #expect(VisionFormat.parseTimestamp("yesterday") == nil)
    }
}
