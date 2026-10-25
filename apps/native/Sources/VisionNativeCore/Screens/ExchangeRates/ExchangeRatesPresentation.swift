import Foundation

/// `EXCHANGE_RATE_TABS` with `useTabParam(EXCHANGE_RATE_TABS, "live")`.
public enum ExchangeRatesTab: String, CaseIterable, Sendable {
    case live
    case fallback

    public static let parameter = "tab"

    /// The `?tab` value; an unknown or absent value is the default tab.
    public init(route: NativeRoute) {
        self = route.value(Self.parameter).flatMap(ExchangeRatesTab.init(rawValue:)) ?? .live
    }

    public var titleKey: String {
        switch self {
        case .live: return "exchangeRates.liveRates"
        case .fallback: return "exchangeRates.fallbackRates"
        }
    }

    /// `Database` and `Globe`.
    public var symbol: String {
        switch self {
        case .live: return "cylinder.split.1x2"
        case .fallback: return "globe"
        }
    }
}

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
        public let currency: String
        /// `1 CUR = x EUR`, six fraction digits.
        public let rate: String
        /// `1 EUR = x CUR`, four fraction digits.
        public let inverse: String
        /// `100 CUR` in euros, with the money decimal places.
        public let hundredInEuro: String

        public var id: String { currency }
    }

    public struct Table: Equatable, Sendable {
        public let title: String
        public let description: String
        public let rows: [Row]
        /// The fallback table's caption.
        public let note: String?
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
        data: OpenAPI.ExchangeRates, tab: ExchangeRatesTab, settings: NativeAppSettings, strings: any Localizing,
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
        let fallback = data.fallbackRates.filter { $0.key != "EUR" }.sorted { $0.key < $1.key }

        cards = [
            SummaryCard(
                id: "stored", symbol: "cylinder.split.1x2", title: strings.t("exchangeRates.storedRates"),
                value: VisionFormat.integer(data.totalRates, locale: locale),
                subtext: strings.t("exchangeRates.storedRatesDesc")),
            SummaryCard(
                id: "fallback", symbol: "globe", title: strings.t("exchangeRates.fallbackCurrencies"),
                value: VisionFormat.integer(fallback.count, locale: locale),
                subtext: strings.t("exchangeRates.fallbackCurrenciesDesc")),
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

        func row(_ currency: String, _ rate: Decimal) -> Row {
            Row(
                currency: currency,
                rate: VisionFormat.decimal(rate, fractionDigits: 6, locale: locale),
                inverse: VisionFormat.inverse(rate, fractionDigits: 4, locale: locale),
                hundredInEuro: VisionFormat.currency(
                    100 * rate, code: "EUR", locale: locale, fractionDigits: settings.showDecimalPlaces))
        }

        switch tab {
        case .live where live.isEmpty:
            content = .empty(title: strings.t("exchangeRates.latestEcbRates"), message: strings.t("exchangeRates.noRates"))
        case .live:
            content = .table(
                Table(
                    title: strings.t("exchangeRates.latestEcbRates"),
                    description: strings.t(
                        "exchangeRates.latestEcbDesc",
                        ["count": String(live.count), "date": formattedRateDate, "fetchedAt": formattedFetchedAt ?? ""]),
                    rows: live.map { row($0.currency, $0.rateToEur) }, note: nil))
        case .fallback:
            content = .table(
                Table(
                    title: strings.t("exchangeRates.fallbackRates"), description: strings.t("exchangeRates.fallbackDesc"),
                    rows: fallback.map { row($0.key, $0.value) }, note: strings.t("exchangeRates.fallbackNote")))
        }
    }
}
