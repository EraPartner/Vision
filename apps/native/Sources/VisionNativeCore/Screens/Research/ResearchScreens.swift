import Foundation
import Observation

@MainActor @Observable public final class ResearchScreens {
    public let home: ResearchHomeModel
    public let markets: ResearchMarketsModel
    public let lookup: ResearchMarketLookupModel
    public let watchlist: ResearchWatchlistModel
    public let watchlistAdd: ResearchWatchlistAddModel
    public let compare: ResearchCompareModel
    public var didMutatePortfolio: (@MainActor () async -> Void)?
    public var didMutateWatchlist: (@MainActor () async -> Void)?
    public private(set) var revision = 0
    public var isOnline = true {
        didSet {
            home.isOnline = isOnline
            markets.isOnline = isOnline
            lookup.isOnline = isOnline
            watchlist.isOnline = isOnline
            compare.isOnline = isOnline
            home.search.isOnline = isOnline
            lookup.search.isOnline = isOnline
            compare.search.isOnline = isOnline
        }
    }
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var activeRoute: NativeRoute?
    @ObservationIgnored private var visitRevision = UUID()
    public init(service: any ResearchService, cache: ResearchReadCache? = nil) {
        let cache = cache ?? ResearchReadCache()
        self.cache = cache
        home = ResearchHomeModel(service: service, cache: cache)
        markets = ResearchMarketsModel(service: service, cache: cache)
        lookup = ResearchMarketLookupModel(service: service, cache: cache)
        watchlistAdd = ResearchWatchlistAddModel(service: service)
        watchlist = ResearchWatchlistModel(service: service, add: watchlistAdd, cache: cache)
        compare = ResearchCompareModel(service: service, cache: cache)
        lookup.action.didMutate = { [weak self] in await self?.didMutatePortfolio?() }
        watchlist.didMutate = { [weak self] in await self?.watchlistChanged(refreshCurrent: false) }
        watchlistAdd.didMutate = { [weak self] in await self?.watchlistChanged(refreshCurrent: true) }
    }
    public convenience init(client: APIClient) { self.init(service: client) }
    public func configure(settings: NativeAppSettings) {
        lookup.configure(settings: settings)
        watchlist.configure(settings: settings)
    }
    public func didAppear(route: NativeRoute) async { await load(route: route) }
    public func load(route: NativeRoute, force: Bool = false) async {
        if activeRoute?.path != route.path {
            if let previous = activeRoute { disappear(path: previous.path) }
            visitRevision = UUID()
            if route.path == "/research" { home.beginVisit() }
            if route.path == "/research/markets" { markets.beginVisit() }
        }
        activeRoute = route
        let visit = visitRevision
        switch route.path {
        case "/research": await home.load(force: force)
        case "/research/markets": await markets.load(force: force)
        case "/research/market": await lookup.load(route: route, force: force)
        case "/research/watchlist": await watchlist.load(force: force)
        case "/research/compare": await compare.load(route: route, force: force)
        default: return
        }
        guard visit == visitRevision else { return }
    }
    public func didDisappear(route: NativeRoute) {
        guard activeRoute?.path == route.path else { return }
        visitRevision = UUID()
        activeRoute = nil
        disappear(path: route.path)
    }
    private func disappear(path: String) {
        switch path {
        case "/research": home.didDisappear()
        case "/research/markets": markets.didDisappear()
        case "/research/market":
            lookup.didDisappear()
            if !watchlistAdd.isSubmitting { watchlistAdd.close() }
        case "/research/watchlist": watchlist.didDisappear()
        case "/research/compare": compare.didDisappear()
        default: break
        }
    }
    public func invalidate() {
        revision += 1
        guard let route = activeRoute else { return }
        switch route.path {
        case "/research": home.invalidate()
        case "/research/markets": markets.invalidate()
        case "/research/market": lookup.invalidate()
        case "/research/watchlist": watchlist.invalidate()
        case "/research/compare": compare.invalidate()
        default: return
        }
        Task { [weak self] in
            guard let self, activeRoute?.string == route.string else { return }
            await load(route: route, force: true)
        }
    }
    public func portfolioDataDidChange() {
        revision += 1
        markets.invalidate()
        lookup.portfolioDataDidChange()
        if activeRoute?.path == "/research/markets" {
            Task { [weak self] in
                guard let self, activeRoute?.path == "/research/markets" else { return }
                await markets.refreshHoldings()
            }
        }
    }
    private func watchlistChanged(refreshCurrent: Bool) async {
        revision += 1
        home.invalidateWatchlist()
        watchlist.invalidate()
        await didMutateWatchlist?()
        if let route = activeRoute {
            if route.path == "/research" {
                await home.load()
            } else if route.path == "/research/watchlist", refreshCurrent {
                await watchlist.refreshAfterAdd()
            }
        }
    }
}
