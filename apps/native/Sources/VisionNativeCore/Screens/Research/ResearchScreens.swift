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
            if let previous = activeRoute { disappear(screen: previous.screen) }
            visitRevision = UUID()
            if route.screen == .researchHome { home.beginVisit() }
            if route.screen == .researchMarkets { markets.beginVisit() }
        }
        activeRoute = route
        let visit = visitRevision
        switch route.screen {
        case .researchHome: await home.load(force: force)
        case .researchMarkets: await markets.load(force: force)
        case .researchMarketLookup: await lookup.load(route: route, force: force)
        case .researchWatchlist: await watchlist.load(force: force)
        case .researchCompare: await compare.load(route: route, force: force)
        default: return
        }
        guard visit == visitRevision else { return }
    }
    public func didDisappear(route: NativeRoute) {
        guard activeRoute?.path == route.path else { return }
        visitRevision = UUID()
        activeRoute = nil
        disappear(screen: route.screen)
    }
    private func disappear(screen: NativeScreen?) {
        switch screen {
        case .researchHome: home.didDisappear()
        case .researchMarkets: markets.didDisappear()
        case .researchMarketLookup:
            lookup.didDisappear()
            if !watchlistAdd.isSubmitting { watchlistAdd.close() }
        case .researchWatchlist: watchlist.didDisappear()
        case .researchCompare: compare.didDisappear()
        default: break
        }
    }
    public func invalidate() {
        revision += 1
        guard let route = activeRoute else { return }
        switch route.screen {
        case .researchHome: home.invalidate()
        case .researchMarkets: markets.invalidate()
        case .researchMarketLookup: lookup.invalidate()
        case .researchWatchlist: watchlist.invalidate()
        case .researchCompare: compare.invalidate()
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
        if activeRoute?.screen == .researchMarkets {
            Task { [weak self] in
                guard let self, activeRoute?.screen == .researchMarkets else { return }
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
            if route.screen == .researchHome {
                await home.load()
            } else if route.screen == .researchWatchlist, refreshCurrent {
                await watchlist.refreshAfterAdd()
            }
        }
    }
}
