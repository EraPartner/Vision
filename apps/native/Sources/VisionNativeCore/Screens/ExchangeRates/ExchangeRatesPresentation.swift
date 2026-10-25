import Foundation

/// Everything `ExchangeRatesPage` renders from a loaded result, as text.
public struct ExchangeRatesPresentation: Equatable, Sendable {
    public struct SummaryCard: Equatable, Sendable, Identifiable {
        public let id: String
        public let symbol: String
        public let title: String
        public let value: String
        public let subtext: String
    }

    public struct Row: Equatable, Sendable, Identifiable {
        public let currency: CurrencyCode
        /// `1 CUR = x EUR`, six fraction digits.
        public let rate: String
        /// `1 EUR = x CUR`, four fraction digits.
        public let inverse: String
        /// `100 CUR` in euros, with the money decimal places.
        public let hundredInEuro: String

        public var id: String { currency.rawValue }
    }

    public struct Table: Equatable, Sendable {
        public let title: String
        public let description: String
        public let rows: [Row]
    }

    public enum Content: Equatable, Sendable {
        /// The live tab without stored rates: the empty state with a Refresh button.
        case empty(title: String, message: String)
        case table(Table)
    }

    public let cards: [SummaryCard]
    public let content: Content
    public let columns: [String]

    public init(
        data: OpenAPI.ExchangeRates, settings: NativeAppSettings, strings: any Localizing,
        timeZone: TimeZone = .current
    ) {
        let locale = settings.numberFormat.locale
        let live = data.rates
        let rateDate = live.first?.rateDate
        let fetchedAt = live.first?.fetchedAt
        let formattedRateDate = rateDate.map { VisionFormat.appDate($0, format: settings.dateFormat, timeZone: timeZone) } ?? "—"
        let formattedFetchedAt = fetchedAt.map {
            VisionFormat.appDateTime($0, format: settings.dateFormat, locale: locale, timeZone: timeZone)
        }

        cards = [
            SummaryCard(
                id: "stored", symbol: "cylinder.split.1x2", title: strings.t("exchangeRates.storedRates"),
                value: VisionFormat.integer(data.totalRates, locale: locale),
                subtext: strings.t("exchangeRates.storedRatesDesc")),
            SummaryCard(
                id: "latest", symbol: "arrow.clockwise", title: strings.t("exchangeRates.latestFetch"),
                value: formattedRateDate,
                subtext: formattedFetchedAt.map { strings.t("exchangeRates.fetchedAt", ["date": $0]) }
                    ?? strings.t("exchangeRates.noDataFetched")),
        ]
        columns = [
            strings.t("exchangeRates.col.currency"), strings.t("exchangeRates.col.unitToEur"),
            strings.t("exchangeRates.col.eurToUnit"), strings.t("exchangeRates.col.hundredInEur"),
        ]

        func row(_ currency: CurrencyCode, _ rate: Decimal) -> Row {
            Row(
                currency: currency,
                rate: VisionFormat.decimal(rate, fractionDigits: 6, locale: locale),
                inverse: VisionFormat.inverse(rate, fractionDigits: 4, locale: locale),
                hundredInEuro: VisionFormat.currency(
                    100 * rate, code: LedgerCurrency.eur, locale: locale, fractionDigits: settings.showDecimalPlaces))
        }

        if live.isEmpty {
            content = .empty(title: strings.t("exchangeRates.latestEcbRates"), message: strings.t("exchangeRates.noRates"))
        } else {
            content = .table(
                Table(
                    title: strings.t("exchangeRates.latestEcbRates"),
                    description: strings.t(
                        "exchangeRates.latestEcbDesc",
                        ["count": String(live.count), "date": formattedRateDate, "fetchedAt": formattedFetchedAt ?? ""]),
                    rows: live.map { row($0.currency, $0.rateToEur) }))
        }
    }
}
