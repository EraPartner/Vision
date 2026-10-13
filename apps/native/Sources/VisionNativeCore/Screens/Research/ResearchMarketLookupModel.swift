import Foundation
import Observation

public struct ResearchMarketLookupState: Equatable, Sendable {
    public let route: NativeRoute
    public var symbol: String? {
        route.value("symbol").map { $0.trimmingCharacters(in: .whitespacesAndNewlines).uppercased() }.flatMap {
            $0.isEmpty ? nil : $0
        }
    }
    public var rawInvestmentId: String? { route.value("investmentId") }
    public var mappingInvestmentId: Int? {
        guard let raw = rawInvestmentId,
            let number = Decimal(string: raw.trimmingCharacters(in: .whitespacesAndNewlines)), number > 0,
            number <= Decimal(Int.max), Decimal(NSDecimalNumber(decimal: number).intValue) == number
        else { return nil }
        return NSDecimalNumber(decimal: number).intValue
    }
    public var range: ResearchRangeOption {
        ResearchRangeOption.lookup.first { $0.range == route.value("range") } ?? ResearchRangeOption.lookup.first {
            $0.range == "1mo"
        }!
    }
    public var tab: String {
        ["fundamentals", "analyst", "news"].contains(route.value("tab") ?? "") ? route.value("tab")! : "fundamentals"
    }
    public init(route: NativeRoute) { self.route = route }
    public func selecting(_ symbol: String) -> NativeRoute {
        route.setting("symbol", to: symbol).removing("investmentId")
    }
    public func selectingRange(_ range: String) -> NativeRoute {
        range == "1mo" ? route.removing("range") : route.setting("range", to: range)
    }
    public func selectingTab(_ tab: String) -> NativeRoute {
        route.setting("tab", to: tab)
    }
    public static func historyDays(_ range: String) -> Int {
        ["1d": 1, "5d": 5, "1mo": 30, "3mo": 91, "6mo": 182, "1y": 365, "5y": 1825][range] ?? 0
    }
}
@MainActor @Observable public final class ResearchMarketLookupModel {
    public let search: ResearchSearchModel
    public let mapping: ResearchMarketMappingModel
    public let action: ResearchMarketActionModel
    public private(set) var route = NativeRoute(path: "/research/market")
    public var state: ResearchMarketLookupState { .init(route: route) }
    public private(set) var holdings: [PortfolioHolding] = []
    public private(set) var holdingsLoaded = false
    public private(set) var quote: ResearchQuote?
    public private(set) var chart: ResearchChartData?
    public private(set) var fundamentals: ResearchSnapshot<ResearchScorecardData?>?
    public private(set) var analyst: ResearchSnapshot<ResearchAnalystData?>?
    public private(set) var analystPresentation: TaxValue?
    public private(set) var news: ResearchSnapshot<ResearchNewsData>?
    public private(set) var isQuoteFetching = false
    public private(set) var isChartFetching = false
    public private(set) var isDetailFetching = false
    public private(set) var errors: [String: String] = [:]
    public var isOnline = true { didSet { search.isOnline = isOnline } }
    public var providerHolding: PortfolioHolding? {
        guard let raw = state.rawInvestmentId else { return nil }
        return holdings.first {
            String($0.id) == raw && !($0.priceProvider ?? "").isEmpty && $0.priceProvider != "yahoo"
        }
    }
    public var isProviderAsset: Bool { providerHolding != nil }
    public var isResolvingProvider: Bool { state.rawInvestmentId != nil && !holdingsLoaded }
    public var existingHolding: PortfolioHolding? {
        guard let symbol = quote?.symbol else { return nil }
        return holdings.first { $0.symbol?.lowercased() == symbol.lowercased() }
    }
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var settings = NativeAppSettings.defaults
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var holdingsRevision = UUID()
    @ObservationIgnored private var detailRevision = UUID()
    @ObservationIgnored private var isActive = false
    @ObservationIgnored private let now: @Sendable () -> Date
    public init(
        service: any ResearchService, cache: ResearchReadCache? = nil, now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.service = service
        let cache = cache ?? ResearchReadCache()
        self.cache = cache
        self.now = now
        search = ResearchSearchModel(service: service, source: .market, trim: false, minLength: 1, cache: cache)
        mapping = ResearchMarketMappingModel(service: service, cache: cache)
        action = ResearchMarketActionModel(service: service, now: now)
        mapping.didMutate = { [weak self] in
            guard let self else { return }
            if let holding = providerHolding {
                cache.invalidate(key: "lookup-history:\(holding.id):\(state.range.range)")
            }
            portfolioDataDidChange()
        }
    }
    public func configure(settings: NativeAppSettings) {
        if self.settings.defaultCurrency != settings.defaultCurrency {
            let providerLane = isProviderAsset || isResolvingProvider
            holdingsLoaded = false
            holdingsRevision = UUID()
            holdings = []
            if providerLane {
                revision = UUID()
                quote = nil
                chart = nil
                isQuoteFetching = false
                isChartFetching = false
            }
        }
        self.settings = settings
        bindActions()
    }
    private func bindActions() {
        action.configure(quote: quote ?? action.quote, holding: existingHolding, numberFormat: settings.numberFormat)
        mapping.configure(
            instrumentKey: state.symbol ?? "", displayName: quote?.name ?? state.symbol ?? "",
            investmentId: state.mappingInvestmentId)
    }
    public func selectSymbol(_ symbol: String) -> NativeRoute {
        search.clear()
        return state.selecting(symbol)
    }
    public func selectRange(_ range: String) -> NativeRoute { state.selectingRange(range) }
    public func selectTab(_ tab: String) -> NativeRoute { state.selectingTab(tab) }
    public func load(route: NativeRoute, force: Bool = false) async {
        isActive = true
        let old = state
        self.route = route
        let current = state
        if old.symbol != current.symbol || old.rawInvestmentId != current.rawInvestmentId {
            revision = UUID()
            detailRevision = UUID()
            quote = nil
            chart = nil
            fundamentals = nil
            analyst = nil
            analystPresentation = nil
            news = nil
            isQuoteFetching = false
            isChartFetching = false
            isDetailFetching = false
            errors = [:]
            mapping.configure(
                instrumentKey: current.symbol ?? "", displayName: current.symbol ?? "",
                investmentId: current.mappingInvestmentId)
            action.configure(quote: nil, holding: nil, numberFormat: settings.numberFormat)
        } else if old.range != current.range {
            revision = UUID()
            isQuoteFetching = false
            isChartFetching = false
            chart = nil
        }
        if old.tab != current.tab {
            detailRevision = UUID()
            isDetailFetching = false
        }
        bindActions()
        // Resolve active summaries before issuing any Yahoo read for a held-provider URL.
        if !holdingsLoaded || force { await loadHoldings(force: force) }
        guard isActive, current == state else { return }
        guard current.symbol != nil else { return }
        async let primary: Void = loadPrimary(force: force)
        async let detail: Void = loadDetail(force: force)
        _ = await (primary, detail)
    }
    private func loadHoldings(force: Bool) async {
        let stamp = holdingsRevision
        let currency = settings.defaultCurrency
        let service = service
        do {
            let data: PortfolioSummaryData = try await cache.request(
                key: "lookup-summary:" + currency, freshFor: 60, force: force
            ) {
                try await service.researchPortfolioSummary(currency: currency)
            }
            guard stamp == holdingsRevision else { return }
            holdings = data.summaries
            holdingsLoaded = true
            bindActions()
        } catch {
            if stamp == holdingsRevision {
                holdingsLoaded = true
                errors["holdings"] = error.localizedDescription
            }
        }
    }
    private func loadPrimary(force: Bool) async {
        guard let symbol = state.symbol, !isResolvingProvider else { return }
        let stamp = revision
        let range = state.range
        let service = service
        if let holding = providerHolding {
            isQuoteFetching = true
            isChartFetching = true
            defer {
                if stamp == revision {
                    isQuoteFetching = false
                    isChartFetching = false
                }
            }
            let days = ResearchMarketLookupState.historyDays(range.range)
            let from = days == 0 ? Decimal(0) : Decimal(now().timeIntervalSince1970 * 1000) - Decimal(days * 86_400_000)
            do {
                let history: ResearchPriceHistoryData = try await cache.request(
                    key: "lookup-history:\(holding.id):\(range.range)", freshFor: 60, force: force
                ) {
                    try await service.researchPriceHistory(id: holding.id, fromMs: from, dbOnly: false)
                }
                let points: [TaxValue] = history.points.map {
                    .object([
                        "time": .number($0.timestampMs), "close": .number($0.price), "high": .number($0.price),
                        "low": .number($0.price), "volume": .number(0),
                    ])
                }
                let chart = try ResearchChartData(
                    raw: .object([
                        "symbol": .string(holding.symbol ?? symbol), "currency": .string(holding.currency),
                        "points": .array(points),
                    ]))
                let body: TaxValue = .object([
                    "kind": .string("providerQuote"), "selectedSymbol": .string(symbol), "points": .array(points),
                    "investment": .object([
                        "symbol": holding.symbol.map(TaxValue.string) ?? .null, "name": .string(holding.name),
                        "currency": .string(holding.currency),
                        "priceProvider": holding.priceProvider.map(TaxValue.string) ?? .null,
                    ]),
                ])
                let response = try await service.researchPresentation(body)
                guard response["kind"] == .string("providerQuote"), let raw = response["result"] else {
                    throw ResearchDecode.failure("Invalid provider quote presentation")
                }
                let synthesized = raw == .null ? nil : try ResearchQuote(raw: raw)
                guard stamp == revision else { return }
                self.chart = chart
                quote = synthesized
                bindActions()
            } catch { if stamp == revision { errors["chart"] = error.localizedDescription } }
        } else {
            async let quote: Void = loadQuote(symbol: symbol, stamp: stamp, force: force)
            async let chart: Void = loadChart(symbol: symbol, range: range, stamp: stamp, force: force)
            _ = await (quote, chart)
        }
    }
    private func loadQuote(symbol: String, stamp: UUID, force: Bool) async {
        guard isOnline, !isQuoteFetching else { return }
        isQuoteFetching = true
        defer { if stamp == revision { isQuoteFetching = false } }
        do {
            let service = service
            let quotes: [ResearchQuote] = try await cache.request(
                key: ResearchReadKey.quotes(symbols: [symbol]), freshFor: 30, force: force
            ) { try await service.marketQuotes(symbols: [symbol], detail: "basic") }
            guard stamp == revision else { return }
            quote = quotes.first
            errors["quote"] = nil
            bindActions()
        } catch { if stamp == revision { errors["quote"] = error.localizedDescription } }
    }
    private func loadChart(symbol: String, range: ResearchRangeOption, stamp: UUID, force: Bool) async {
        guard !isChartFetching else { return }
        isChartFetching = true
        defer { if stamp == revision { isChartFetching = false } }
        do {
            let service = service
            let data: ResearchChartData = try await cache.request(
                key: ResearchReadKey.marketChart(symbol: symbol, range: range.range, interval: range.interval),
                freshFor: 60, force: force
            ) { try await service.marketChart(symbol: symbol, range: range.range, interval: range.interval) }
            guard stamp == revision else { return }
            chart = data
            errors["chart"] = nil
        } catch { if stamp == revision { errors["chart"] = error.localizedDescription } }
    }
    private func loadDetail(force: Bool) async {
        guard let symbol = state.symbol, !isProviderAsset, !isDetailFetching else { return }
        let tab = state.tab
        let stamp = detailRevision
        let service = service
        isDetailFetching = true
        defer { if stamp == detailRevision { isDetailFetching = false } }
        do {
            switch tab {
            case "analyst":
                let data: ResearchSnapshot<ResearchAnalystData?> = try await cache.request(
                    key: "lookup-analyst:" + symbol, freshFor: 86_400, force: force
                ) { try await service.researchAnalyst(symbol: symbol) }
                let response = try await service.researchPresentation(
                    .object(["kind": .string("analyst"), "consensus": data.data?.consensus?.raw ?? .null]))
                guard response["kind"] == .string("analyst"), let result = response["result"] else {
                    throw ResearchDecode.failure("Invalid analyst presentation")
                }
                try Self.validateAnalyst(result)
                guard stamp == detailRevision else { return }
                analyst = data
                analystPresentation = result == .null ? nil : result
            case "news":
                let data: ResearchSnapshot<ResearchNewsData> = try await cache.request(
                    key: "lookup-news:" + symbol, freshFor: 7200, force: force
                ) { try await service.researchNews(symbol: symbol) }
                guard stamp == detailRevision else { return }
                news = data
            default:
                let data: ResearchSnapshot<ResearchScorecardData?> = try await cache.request(
                    key: ResearchReadKey.scorecard(symbol: symbol), freshFor: 86_400, force: force
                ) { try await service.researchScorecard(symbol: symbol, assetClass: nil) }
                guard stamp == detailRevision else { return }
                fundamentals = data
            }
        } catch { if stamp == detailRevision { errors[tab] = error.localizedDescription } }
    }
    private static func validateAnalyst(_ result: TaxValue) throws {
        if result == .null { return }
        guard let total = result["total"]?.decimalValue, !total.isNaN, total > 0,
            result["verdictKey"]?.stringValue != nil,
            ["success", "warning", "destructive"].contains(result["tone"]?.stringValue ?? "")
        else { throw ResearchDecode.failure("Invalid analyst presentation") }
        let values =
            [result["bullFraction"], result["bearFraction"]]
            + ["strongBuy", "buy", "hold", "sell", "strongSell"].map { result["fractions"]?[$0] }
        for value in values {
            guard let number = value?.decimalValue, !number.isNaN, (0...1).contains(number) else {
                throw ResearchDecode.failure("Invalid analyst presentation fraction")
            }
        }
    }
    public func refreshQuotes() async {
        guard isActive, isOnline, !isProviderAsset, let symbol = state.symbol else { return }
        await loadQuote(symbol: symbol, stamp: revision, force: true)
    }
    public func portfolioDataDidChange() {
        cache.invalidate(key: "lookup-summary:" + settings.defaultCurrency)
        holdingsRevision = UUID()
        holdingsLoaded = false
        if isActive {
            Task {
                let before = providerHolding
                await loadHoldings(force: true)
                // A structural provider change switches the source; ordinary portfolio mutations only rebind options.
                if before?.id != providerHolding?.id || before?.priceProvider != providerHolding?.priceProvider
                    || before?.priceProviderId != providerHolding?.priceProviderId
                {
                    revision = UUID()
                    quote = nil
                    chart = nil
                    isQuoteFetching = false
                    isChartFetching = false
                    await loadPrimary(force: true)
                }
            }
        }
    }
    public func invalidate() {
        cache.invalidate(prefix: "lookup-")
        if let symbol = state.symbol {
            cache.invalidate(key: ResearchReadKey.quotes(symbols: [symbol]))
            cache.invalidate(
                key: ResearchReadKey.marketChart(
                    symbol: symbol, range: state.range.range, interval: state.range.interval))
            cache.invalidate(key: ResearchReadKey.scorecard(symbol: symbol))
        }
        revision = UUID()
        detailRevision = UUID()
        holdingsRevision = UUID()
        holdingsLoaded = false
        isQuoteFetching = false
        isChartFetching = false
        isDetailFetching = false
    }
    public func didDisappear() {
        isActive = false
        revision = UUID()
        detailRevision = UUID()
        holdingsRevision = UUID()
        search.clear()
        mapping.reset()
        action.discardDrafts()
        isQuoteFetching = false
        isChartFetching = false
        isDetailFetching = false
    }
}
