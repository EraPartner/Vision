import Foundation
import Observation

@MainActor @Observable public final class ResearchMarketsModel {
    public var region: ResearchMarketRegion = .worldwide { didSet { if region != oldValue { selectionChanged() } } }
    public var sector = "overview" { didSet { if sector != oldValue { selectionChanged() } } }
    public private(set) var quotes: [ResearchQuote] = []
    public private(set) var investments: [PortfolioInvestment] = []
    public private(set) var isLoading = false
    public private(set) var isInvestmentsLoading = false
    public private(set) var error: String?
    public private(set) var investmentsError: String?
    public var isOnline = true
    public var groups: [ResearchMarketGroup] { ResearchMarketCatalog.groups(region: region, sector: sector) }
    public var symbols: [String] {
        var seen = Set<String>()
        return groups.flatMap(\.entries).map(\.symbol).filter { seen.insert($0).inserted }
    }
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var quoteRevision = UUID()
    @ObservationIgnored private var investmentsRevision = UUID()
    @ObservationIgnored private var active = false
    @ObservationIgnored private var task: Task<Void, Never>?
    public init(service: any ResearchService, cache: ResearchReadCache? = nil) {
        self.service = service
        self.cache = cache ?? ResearchReadCache()
    }
    public func isHeld(_ symbol: String) -> Bool {
        let value = symbol.uppercased()
        let held = Set(
            investments.flatMap { investment -> [String] in
                var values: [String] = []
                if let symbol = investment.symbol { values.append(symbol.uppercased()) }
                if investment.priceProvider == .yahoo, let identity = investment.priceProviderId {
                    values.append(identity.uppercased())
                }
                return values
            })
        return held.contains(value) || value.hasSuffix("-USD") && held.contains(String(value.dropLast(4)))
    }
    private func selectionChanged() {
        quoteRevision = UUID()
        isLoading = false
        quotes = []
        error = nil
        guard active else { return }
        task?.cancel()
        task = Task { [weak self] in await self?.refreshQuotes(force: false) }
    }
    public func beginVisit() {
        active = false
        region = .worldwide
        sector = "overview"
        active = true
    }
    public func load(force: Bool = false) async {
        async let quotes: Void = refreshQuotes(force: force)
        async let investments: Void = loadInvestments(force: force)
        _ = await (quotes, investments)
    }
    public func refreshQuotes(force: Bool = true) async {
        guard isOnline, !isLoading else { return }
        let symbols = symbols
        guard !symbols.isEmpty else {
            quotes = []
            return
        }
        let generation = UUID()
        quoteRevision = generation
        isLoading = true
        defer { if generation == quoteRevision { isLoading = false } }
        do {
            let service = service
            let values: [ResearchQuote] = try await cache.request(
                key: ResearchReadKey.quotes(symbols: symbols), freshFor: 60, force: force
            ) { try await service.marketQuotes(symbols: symbols, detail: "basic") }
            guard generation == quoteRevision, symbols == self.symbols else { return }
            quotes = values
            error = nil
        } catch { if generation == quoteRevision { self.error = error.localizedDescription } }
    }
    private func loadInvestments(force: Bool) async {
        let generation = UUID()
        investmentsRevision = generation
        isInvestmentsLoading = true
        defer { if generation == investmentsRevision { isInvestmentsLoading = false } }
        do {
            let service = service
            let values: [PortfolioInvestment] = try await cache.request(
                key: ResearchReadKey.investments, freshFor: 120, force: force
            ) { try await service.researchInvestments() }
            guard generation == investmentsRevision else { return }
            investments = values
            investmentsError = nil
        } catch { if generation == investmentsRevision { investmentsError = error.localizedDescription } }
    }
    public func refreshHoldings() async { await loadInvestments(force: false) }
    public func didDisappear() {
        active = false
        task?.cancel()
        task = nil
        quoteRevision = UUID()
        investmentsRevision = UUID()
        isLoading = false
        isInvestmentsLoading = false
    }
    public func invalidate() {
        cache.invalidate(key: ResearchReadKey.investments)
        investmentsRevision = UUID()
        isInvestmentsLoading = false
    }
}
