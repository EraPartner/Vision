import Foundation
import Observation

public struct ResearchBenchmark: Equatable, Sendable, Identifiable {
    public let symbol: String
    public let label: String
    public var id: String { symbol }
    public init(symbol: String, label: String) {
        self.symbol = symbol
        self.label = label
    }
}
@MainActor @Observable public final class ResearchHomeModel {
    public static let benchmarkDefinitions: [ResearchBenchmark] = [
        .init(symbol: "^GSPC", label: "S&P 500"), .init(symbol: "^STOXX50E", label: "Euro Stoxx 50"),
        .init(symbol: "^FTSE", label: "FTSE 100"), .init(symbol: "^BFX", label: "BEL 20"),
        .init(symbol: "BTC-USD", label: "Bitcoin"),
    ]
    public static var benchmarks: [ResearchBenchmark] { Self.benchmarkDefinitions }
    public let search: ResearchSearchModel
    public private(set) var benchmarkQuotes: [ResearchQuote] = []
    public private(set) var watchlist: [ResearchWatchlistItem] = []
    public private(set) var watchlistQuotes: [ResearchQuote] = []
    public private(set) var news: [ResearchNewsArticle] = []
    public private(set) var isBenchmarksLoading = false
    public private(set) var isWatchlistLoading = false
    public private(set) var isWatchlistQuotesLoading = false
    public private(set) var isNewsLoading = false
    public private(set) var errors: [String: String] = [:]
    public var isOnline = true { didSet { search.isOnline = isOnline } }
    public var watchlistPreview: [ResearchWatchlistItem] { Array(watchlist.prefix(9)) }
    public var newsSymbols: [String] { Array(watchlist.compactMap(\.symbol).filter { !$0.isEmpty }.prefix(10)) }
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var benchmarkRevision = UUID()
    @ObservationIgnored private var listRevision = UUID()
    @ObservationIgnored private var quoteRevision = UUID()
    @ObservationIgnored private var newsRevision = UUID()
    @ObservationIgnored private var visitRevision = UUID()
    public init(service: any ResearchService, cache: ResearchReadCache? = nil) {
        self.service = service
        let cache = cache ?? ResearchReadCache()
        self.cache = cache
        search = ResearchSearchModel(service: service, source: .research, cache: cache)
    }
    public func load(force: Bool = false) async {
        let visit = visitRevision
        async let list: Void = loadWatchlist(force: force)
        async let benchmarks: Void = loadBenchmarks(force: force)
        _ = await (list, benchmarks)
        guard visit == visitRevision, !Task.isCancelled else { return }
        async let quotes: Void = loadWatchlistQuotes(force: force)
        async let news: Void = loadNews(force: force)
        _ = await (quotes, news)
    }
    public func refreshQuotes() async {
        async let benchmarks: Void = loadBenchmarks(force: true)
        async let watchlist: Void = loadWatchlistQuotes(force: true)
        _ = await (benchmarks, watchlist)
    }
    private func loadBenchmarks(force: Bool) async {
        guard isOnline, !isBenchmarksLoading else { return }
        let generation = UUID()
        benchmarkRevision = generation
        isBenchmarksLoading = true
        defer { if generation == benchmarkRevision { isBenchmarksLoading = false } }
        do {
            let service = service
            let symbols = Self.benchmarkDefinitions.map(\.symbol)
            let values: [ResearchQuote] = try await cache.request(
                key: ResearchReadKey.quotes(symbols: symbols), freshFor: 60, force: force
            ) { try await service.marketQuotes(symbols: symbols, detail: "basic") }
            guard generation == benchmarkRevision else { return }
            benchmarkQuotes = values
            errors["benchmarks"] = nil
        } catch { if generation == benchmarkRevision { errors["benchmarks"] = error.localizedDescription } }
    }
    private func loadWatchlist(force: Bool) async {
        let generation = UUID()
        listRevision = generation
        isWatchlistLoading = true
        defer { if generation == listRevision { isWatchlistLoading = false } }
        do {
            let service = service
            let page: ResearchWatchlistPage = try await cache.request(
                key: ResearchReadKey.watchlist, freshFor: 60, force: force
            ) { try await service.researchWatchlist() }
            guard generation == listRevision else { return }
            if watchlist.map(\.symbol) != page.items.map(\.symbol) {
                quoteRevision = UUID()
                newsRevision = UUID()
                isWatchlistQuotesLoading = false
                isNewsLoading = false
                watchlistQuotes = []
                news = []
            }
            watchlist = page.items
            errors["watchlist"] = nil
        } catch { if generation == listRevision { errors["watchlist"] = error.localizedDescription } }
    }
    private func loadWatchlistQuotes(force: Bool) async {
        guard isOnline, !isWatchlistQuotesLoading else { return }
        let symbols = watchlist.compactMap(\.symbol).filter { !$0.isEmpty }
        guard !symbols.isEmpty else {
            watchlistQuotes = []
            errors["quotes"] = nil
            return
        }
        let generation = UUID()
        quoteRevision = generation
        isWatchlistQuotesLoading = true
        defer { if generation == quoteRevision { isWatchlistQuotesLoading = false } }
        do {
            let service = service
            let values: [ResearchQuote] = try await cache.request(
                key: ResearchReadKey.quotes(symbols: symbols), freshFor: 60, force: force
            ) { try await service.marketQuotes(symbols: symbols, detail: "basic") }
            guard generation == quoteRevision, symbols == watchlist.compactMap(\.symbol).filter({ !$0.isEmpty }) else {
                return
            }
            watchlistQuotes = values
            errors["quotes"] = nil
        } catch { if generation == quoteRevision { errors["quotes"] = error.localizedDescription } }
    }
    public func loadNews(force: Bool = false) async {
        guard isOnline, !isNewsLoading else { return }
        let symbols = newsSymbols
        let generation = UUID()
        newsRevision = generation
        isNewsLoading = true
        defer { if generation == newsRevision { isNewsLoading = false } }
        do {
            let service = service
            let values: [ResearchNewsArticle] = try await cache.request(
                key: ResearchReadKey.news(symbols: symbols, count: 6), freshFor: 300, force: force
            ) { try await service.marketNews(symbols: symbols, count: 6) }
            guard generation == newsRevision, symbols == newsSymbols else { return }
            news = values
            errors["news"] = nil
        } catch { if generation == newsRevision { errors["news"] = error.localizedDescription } }
    }
    public func beginVisit() {
        visitRevision = UUID()
        search.clear()
    }
    public func didDisappear() {
        visitRevision = UUID()
        search.clear()
        benchmarkRevision = UUID()
        listRevision = UUID()
        quoteRevision = UUID()
        newsRevision = UUID()
        isBenchmarksLoading = false
        isWatchlistLoading = false
        isWatchlistQuotesLoading = false
        isNewsLoading = false
    }
    public func invalidateWatchlist() {
        cache.invalidate(key: ResearchReadKey.watchlist)
        cache.invalidate(key: ResearchReadKey.quotes(symbols: watchlist.compactMap(\.symbol).filter { !$0.isEmpty }))
        cache.invalidate(key: ResearchReadKey.news(symbols: newsSymbols, count: 6))
        listRevision = UUID()
        quoteRevision = UUID()
        newsRevision = UUID()
        isWatchlistLoading = false
        isWatchlistQuotesLoading = false
        isNewsLoading = false
    }
    public func invalidate() {
        invalidateWatchlist()
        cache.invalidate(key: ResearchReadKey.quotes(symbols: Self.benchmarkDefinitions.map(\.symbol)))
        benchmarkRevision = UUID()
        isBenchmarksLoading = false
        visitRevision = UUID()
    }
}
