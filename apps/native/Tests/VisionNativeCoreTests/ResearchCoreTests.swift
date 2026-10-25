import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native research shared reads and scopes")
struct ResearchCoreTests {
    @Test func nullableProviderLeavesUnknownFieldsAndDecimalPrecisionSurviveTypedRoundtrip() throws {
        let raw: TaxValue = .object([
            "symbol": .string("SYNTH"), "currency": .string("EUR"), "name": .null,
            "price": .number(Decimal(string: "123456789.1234567890123456789")!), "change": .null,
            "unknown": .object(["future": .string("preserve")]),
        ])
        let quote = try ResearchQuote(raw: raw)
        #expect(quote.price == Decimal(string: "123456789.1234567890123456789"))
        #expect(quote.change == nil)
        #expect(quote.changePercent == nil)
        #expect(quote.name == nil)
        #expect(try TaxValue(encoding: quote) == raw)
        let search = try ResearchSearchData(
            raw: .object(["items": .array([.object(["symbol": .null, "name": .string("Unknown provider row")])])]))
        #expect(search.items[0].symbol == nil)
        #expect(search.items[0].exchange == nil)
        #expect(throws: APIError.self) {
            try ResearchQuote(
                raw: .object(["symbol": .string("SYNTH"), "currency": .string("EUR"), "price": .string("12.50")]))
        }
    }
    @Test func researchMetadataPreservesUnknownSourceAndMissingSourceNeverClaimsLive() async throws {
        let transport = ResearchCoreTransport()
        let client = researchCoreClient(transport)
        let result = try await client.researchSearch(query: "synthetic")
        #expect(result.meta.source == "cache")
        #expect(result.meta.provider == "provider-future")
        #expect(result.meta.requestId == "synthetic-correlation")
        #expect(result.meta.raw?["future"] == .array([.bool(true), .null]))
        await transport.metadata(.object(["provider": .string("other"), "source": .string("future-source")]))
        #expect(try await client.researchSearch(query: "second").meta.source == "future-source")
        await transport.metadata(nil)
        let missing = try await client.researchSearch(query: "third")
        #expect(missing.meta.provider == nil)
        #expect(missing.meta.source == "unavailable")
    }
    @Test func quoteAndNewsAdaptersKeepOrderedSymbolsAndExactSourceQueryParameters() async throws {
        let transport = ResearchCoreTransport()
        let client = researchCoreClient(transport)
        _ = try await client.marketQuotes(symbols: ["AAPL", "AAPL", "^GSPC"], detail: "basic")
        _ = try await client.marketNews(symbols: [], count: 6)
        _ = try await client.researchPriceHistory(id: 7, fromMs: 1_234_567_890_123, dbOnly: false)
        let requests = await transport.requests
        #expect(requests[0].queryItems.first { $0.name == "symbols" }?.value == "AAPL,AAPL,^GSPC")
        #expect(requests[0].queryItems.first { $0.name == "detail" }?.value == "basic")
        #expect(!requests[1].queryItems.contains { $0.name == "symbols" })
        #expect(requests[1].queryItems.first { $0.name == "count" }?.value == "6")
        #expect(requests[2].queryItems.first { $0.name == "from_ms" }?.value == "1234567890123")
        #expect(requests[2].queryItems.first { $0.name == "db_only" }?.value == "false")
    }
    @Test func multipartPresentationContainsCapturedRawInputsOnly() async throws {
        let transport = ResearchCoreTransport()
        let input: TaxValue = .object([
            "kind": .string("watchlist"), "targetPrice": .number(Decimal(string: "123.456789012345678901")!),
            "currentPrice": .null, "future": .string("retain"),
        ])
        let result = try await researchCoreClient(transport).researchPresentation(input)
        #expect(result["kind"] == .string("watchlist"))
        let request = try #require(await transport.requests.last)
        #expect(request.contentType.hasPrefix("multipart/form-data; boundary="))
        let body = String(decoding: try #require(request.body), as: UTF8.self)
        #expect(body.contains("name=\"file\"; filename=\"research.json\""))
        #expect(body.contains("123.456789012345678901"))
        #expect(body.contains("\"currentPrice\":null"))
        #expect(!body.contains("name=\"kind\""))
        #expect(await transport.requests.count == 1)
    }
    @Test func readCacheCoalescesSameScopeAndInvalidatedLateReadCannotPopulateFreshCache() async throws {
        let transport = ResearchCoreTransport()
        let client = researchCoreClient(transport)
        let cache = ResearchReadCache()
        await transport.pause(path: "/api/market/quote")
        let key = ResearchReadKey.quotes(symbols: ["SYNTH"])
        let first = Task {
            try await cache.request(key: key, freshFor: 60) {
                try await client.marketQuotes(symbols: ["SYNTH"], detail: "basic")
            }
        }
        await transport.waitForPause()
        let second = Task {
            try await cache.request(key: key, freshFor: 60) {
                try await client.marketQuotes(symbols: ["SYNTH"], detail: "basic")
            }
        }
        await Task.yield()
        #expect(await transport.requests.count == 1)
        cache.invalidate(key: key)
        await transport.release()
        _ = try await first.value
        _ = try await second.value
        _ = try await cache.request(key: key, freshFor: 60) {
            try await client.marketQuotes(symbols: ["SYNTH"], detail: "basic")
        }
        #expect(await transport.requests.count == 2)
    }
    @Test func homeUsesAllQuotesFirstNinePreviewFirstTenNewsAndPreservesMissingPrices() async throws {
        let transport = ResearchCoreTransport()
        await transport.rows(Array(1...12).map { researchWatchlistFixture(id: $0, symbol: "SYNTH\($0)") })
        let home = ResearchHomeModel(service: researchCoreClient(transport))
        await home.load()
        #expect(home.watchlist.count == 12)
        #expect(home.watchlistPreview.count == 9)
        #expect(home.newsSymbols.count == 10)
        #expect(home.benchmarkQuotes.first?.price == nil)
        let requests = await transport.requests
        let quoteQueries = requests.filter { $0.path == "/api/market/quote" }.compactMap {
            $0.queryItems.first { $0.name == "symbols" }?.value
        }
        #expect(quoteQueries.contains(ResearchHomeModel.benchmarks.map(\.symbol).joined(separator: ",")))
        #expect(quoteQueries.contains((1...12).map { "SYNTH\($0)" }.joined(separator: ",")))
        let news = try #require(requests.first { $0.path == "/api/market/news" })
        #expect(
            news.queryItems.first { $0.name == "symbols" }?.value
                == (1...10).map { "SYNTH\($0)" }.joined(separator: ","))
        #expect(news.queryItems.first { $0.name == "count" }?.value == "6")
        await home.load()
        #expect(await transport.requests.count == requests.count)
    }
    @Test func homeOfflineAndLeaveDuringListReadDoNotStartProviderRequests() async throws {
        let transport = ResearchCoreTransport()
        let home = ResearchHomeModel(service: researchCoreClient(transport))
        home.isOnline = false
        await home.load()
        #expect(await transport.requests.map(\.path) == ["/api/watchlist"])
        home.isOnline = true
        await transport.pause(path: "/api/watchlist")
        let load = Task { await home.load(force: true) }
        await transport.waitForPause()
        home.didDisappear()
        await transport.release()
        await load.value
        #expect(await transport.requests.filter { $0.path == "/api/market/news" }.isEmpty)
        #expect(await transport.requests.filter { $0.path == "/api/market/quote" }.count == 1)
    }
    @Test func failedHomeReadRetainsPriorRowsWithFailureAndClearsOnSuccessfulReadback() async throws {
        let transport = ResearchCoreTransport()
        let home = ResearchHomeModel(service: researchCoreClient(transport))
        await home.load()
        let rows = home.watchlist
        await transport.failWatchlist(true)
        await home.load(force: true)
        #expect(home.watchlist == rows)
        #expect(home.errors["watchlist"] != nil)
        await transport.failWatchlist(false)
        await home.load(force: true)
        #expect(home.errors["watchlist"] == nil)
    }
    @Test func marketsCataloguePreservesAllStaticMembershipAndRegionalFilterSemantics() {
        #expect(ResearchMarketCatalog.regionOptions.count == 6)
        #expect(ResearchMarketCatalog.sectorOptions.count == 19)
        let allRegions = ResearchMarketRegion.allCases.flatMap {
            ResearchMarketCatalog.groups(region: $0, sector: "overview").flatMap(\.entries)
        }
        let allSectors = ResearchMarketCatalog.sectorOptions.filter { $0.id != "overview" }.flatMap {
            ResearchMarketCatalog.groups(region: .worldwide, sector: $0.id).flatMap(\.entries)
        }
        #expect(allRegions.count + allSectors.count == 637)
        #expect(Set((allRegions + allSectors).map(\.symbol)).count == 466)
        #expect(ResearchMarketCatalog.groups(region: .worldwide, sector: "overview").count == 2)
        #expect(
            ResearchMarketCatalog.groups(region: .europe, sector: "crypto").flatMap(\.entries).allSatisfy {
                $0.region == .europe
            })
        #expect(
            ResearchMarketCatalog.groups(region: .worldwide, sector: "crypto").flatMap(\.entries).contains {
                $0.symbol == "BTC-USD"
            })
        #expect(
            ResearchMarketCatalog.groups(region: .japan, sector: "semiconductors").flatMap(\.entries).allSatisfy {
                $0.region == .japan
            })
    }
    @Test func marketsStarsUseRawArchiveSymbolsYahooIdentityAndCryptoPairWithoutFinancialComputation() async throws {
        let transport = ResearchCoreTransport()
        await transport.investmentRows([
            .object([
                "id": .number(7), "name": .string("Archived"), "asset_class": .string("stock"),
                "currency": .string("USD"), "is_active": .bool(false), "symbol": .string("ARCH"),
                "price_provider": .string("yahoo"), "price_provider_id": .string("CANON"),
                "created_at": .string("2026-01-01T00:00:00Z"), "updated_at": .string("2026-01-01T00:00:00Z"),
            ]),
            .object([
                "id": .number(8), "name": .string("Coin"), "asset_class": .string("crypto"), "currency": .string("USD"),
                "is_active": .bool(true), "symbol": .string("btc"), "price_provider": .string("manual"),
                "created_at": .string("2026-01-01T00:00:00Z"), "updated_at": .string("2026-01-01T00:00:00Z"),
            ]),
        ])
        let model = ResearchMarketsModel(service: researchCoreClient(transport))
        await model.load()
        #expect(model.investmentsError == nil)
        #expect(model.isHeld("arch"))
        #expect(model.isHeld("CANON"))
        #expect(model.isHeld("BTC-USD"))
        #expect(!model.isHeld("BTC-EUR"))
        let request = try #require(await transport.requests.first { $0.path == "/api/investments" })
        #expect(request.queryItems.first { $0.name == "active" }?.value == "false")
        #expect(request.queryItems.first { $0.name == "limit" }?.value == "500")
    }
    @Test func lateMarketsSelectionCannotShowOldScopeAndVisitResetsOnlyLocalFilters() async throws {
        let transport = ResearchCoreTransport()
        let model = ResearchMarketsModel(service: researchCoreClient(transport))
        await transport.pause(path: "/api/market/quote")
        let load = Task { await model.load() }
        await transport.waitForPause()
        model.region = .japan
        model.sector = "crypto"
        await transport.release()
        await load.value
        #expect(model.quotes.isEmpty)
        model.beginVisit()
        #expect(model.region == .worldwide)
        #expect(model.sector == "overview")
    }
    @Test func explicitHomeRefreshPreservesSearchDraftAndUnrelatedFreshProviderCache() async throws {
        let transport = ResearchCoreTransport()
        let client = researchCoreClient(transport)
        let cache = ResearchReadCache()
        let key = ResearchReadKey.search(source: .research, query: "unrelated")
        let first: ResearchSnapshot<ResearchSearchData> = try await cache.request(key: key, freshFor: 60) {
            try await client.researchSearch(query: "unrelated")
        }
        let home = ResearchHomeModel(service: client, cache: cache)
        home.search.searchText = "Current search draft"
        home.invalidate()
        #expect(home.search.searchText == "Current search draft")
        let second: ResearchSnapshot<ResearchSearchData> = try await cache.request(key: key, freshFor: 60) {
            try await client.researchSearch(query: "unrelated")
        }
        #expect(second == first)
        #expect(await transport.requests.count == 1)
        home.search.clear()
    }
    @Test func coordinatorIgnoresOldRouteDisappearAndPortfolioChangesRefreshOnlyHeldRows() async throws {
        let transport = ResearchCoreTransport()
        let screens = ResearchScreens(client: researchCoreClient(transport))
        let home = NativeRoute(path: "/research")
        let markets = NativeRoute(path: "/research/markets")
        await screens.didAppear(route: home)
        await screens.didAppear(route: markets)
        screens.didDisappear(route: home)
        let beforeSelection = await transport.requests.filter { $0.path == "/api/market/quote" }.count
        screens.markets.region = .japan
        for _ in 0..<100 {
            if await transport.requests.filter({ $0.path == "/api/market/quote" }).count > beforeSelection { break }
            await Task.yield()
        }
        #expect(await transport.requests.filter { $0.path == "/api/market/quote" }.count > beforeSelection)
        let beforeChange = await transport.requests
        screens.portfolioDataDidChange()
        for _ in 0..<100 {
            if await transport.requests.filter({ $0.path == "/api/investments" }).count
                > beforeChange.filter({ $0.path == "/api/investments" }).count
            {
                break
            }
            await Task.yield()
        }
        let afterChange = await transport.requests
        #expect(
            afterChange.filter { $0.path == "/api/investments" }.count == beforeChange.filter {
                $0.path == "/api/investments"
            }.count + 1)
        #expect(
            afterChange.filter { $0.path == "/api/market/quote" }.count
                == beforeChange.filter { $0.path == "/api/market/quote" }.count)
        #expect(!afterChange.contains { $0.path == "/api/research/presentation" })
        screens.didDisappear(route: markets)
        screens.markets.region = .europe
        await Task.yield()
        #expect(await transport.requests.count == afterChange.count)
    }
    @Test func offlineProviderSearchUsesCapturedHitsAndResumesCurrentQueryOnlyWhenOnline() async throws {
        let transport = ResearchCoreTransport()
        let client = researchCoreClient(transport)
        let cache = ResearchReadCache()
        let _: ResearchSnapshot<ResearchSearchData> = try await cache.request(
            key: ResearchReadKey.search(source: .research, query: "cached"), freshFor: 60
        ) {
            try await client.researchSearch(query: "cached")
        }
        let search = ResearchSearchModel(service: client, source: .research, cache: cache, debounceMilliseconds: 1)
        search.isOnline = false
        search.searchText = "cached"
        for _ in 0..<100 {
            if search.searchedQuery == "cached" { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(search.items.first?.symbol == "cached")
        #expect(await transport.requests.count == 1)
        search.searchText = "new"
        for _ in 0..<100 {
            if search.searchedQuery == "new" { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(search.items.isEmpty)
        #expect(search.error == nil)
        #expect(await transport.requests.count == 1)
        search.isOnline = true
        for _ in 0..<100 {
            if search.items.first?.symbol == "new" { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(search.items.first?.symbol == "new")
        #expect(await transport.requests.count == 2)
    }
    @Test func searchesDebounceHideChangedQueryResultsAndSeparateMarketRawWhitespace() async throws {
        let transport = ResearchCoreTransport()
        let service = researchCoreClient(transport)
        let search = ResearchSearchModel(service: service, source: .research, debounceMilliseconds: 1)
        await transport.pause(path: "/api/research/search")
        search.searchText = "  first  "
        await transport.waitForPause()
        search.searchText = "second"
        #expect(!search.isOpen)
        #expect(search.items.isEmpty)
        await transport.release()
        for _ in 0..<100 {
            if search.searchedQuery == "second", !search.isSearching { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(search.isOpen)
        #expect(search.searchedQuery == "second")
        #expect(search.items.first?.symbol == "second")
        let market = ResearchSearchModel(service: service, source: .market, trim: false, debounceMilliseconds: 1)
        market.searchText = "  raw  "
        for _ in 0..<100 {
            if market.searchedQuery == "  raw  ", !market.isSearching { break }
            try await Task.sleep(for: .milliseconds(2))
        }
        #expect(await transport.requests.last?.queryItems.first { $0.name == "q" }?.value == "  raw  ")
        #expect(market.meta == nil)
    }
}
private func researchCoreClient(_ transport: ResearchCoreTransport) -> APIClient {
    .init(baseURL: { URL(string: "http://synthetic.invalid") }, transport: transport, maxRetries: 0)
}
private func researchWatchlistFixture(id: Int = 1, symbol: String = "SYNTH") -> TaxValue {
    .object([
        "id": .number(Decimal(id)), "name": .string("Synthetic"), "symbol": .string(symbol),
        "asset_class": .string("stock"), "target_price": .number(12), "added_price": .null, "currency": .string("EUR"),
        "notes": .null, "price_provider_id": .null, "created_at": .string("2026-01-01T00:00:00Z"),
        "updated_at": .string("2026-01-01T00:00:00Z"),
    ])
}
private actor ResearchCoreTransport: APITransport {
    var requests: [APIRequest] = []
    private var meta: JSONValue? = .object([
        "provider": .string("provider-future"), "source": .string("cache"),
        "requestId": .string("synthetic-correlation"), "future": .array([.bool(true), .null]),
    ])
    private var items = [researchWatchlistFixture()]
    private var investments: [TaxValue] = []
    private var watchlistFails = false
    private var pausePath: String?
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?
    private var began = false
    func metadata(_ value: JSONValue?) { meta = value }
    func rows(_ values: [TaxValue]) { items = values }
    func investmentRows(_ values: [TaxValue]) { investments = values }
    func failWatchlist(_ value: Bool) { watchlistFails = value }
    func pause(path: String) {
        pausePath = path
        began = false
    }
    func waitForPause() async { if !began { await withCheckedContinuation { waiter = $0 } } }
    func release() {
        gate?.resume()
        gate = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        if pausePath == request.path {
            pausePath = nil
            began = true
            waiter?.resume()
            waiter = nil
            await withCheckedContinuation { gate = $0 }
        }
        if request.path == "/api/watchlist", watchlistFails { throw APIError.network("Synthetic failed list refresh") }
        let payload: TaxValue
        switch request.path {
        case "/api/research/search", "/api/market/search":
            payload = .object([
                "items": .array([
                    .object([
                        "symbol": .string(request.queryItems.first { $0.name == "q" }?.value ?? ""),
                        "name": .string("Synthetic"), "type": .string("EQUITY"), "exchange": .string("TEST"),
                    ])
                ])
            ])
        case "/api/watchlist":
            payload = .object([
                "items": .array(items), "total": .number(Decimal(items.count)), "limit": .number(50),
                "offset": .number(0),
            ])
        case "/api/market/quote":
            payload = .object([
                "items": .array([.object(["symbol": .string("SYNTH"), "currency": .string("EUR"), "price": .null])]),
                "total": .number(1),
            ])
        case "/api/market/news": payload = .object(["items": .array([]), "total": .number(0)])
        case "/api/investments":
            payload = .object(["items": .array(investments), "total": .number(Decimal(investments.count))])
        case "/api/investments/7/price-history":
            payload = .object([
                "investment_id": .number(7), "provider": .string("future-provider"), "points": .array([]),
            ])
        case "/api/research/presentation": payload = .object(["kind": .string("watchlist"), "result": .object([:])])
        default: throw APIError.invalidRequest("Unexpected synthetic endpoint " + request.path)
        }
        var body: TaxValue = .object(["ok": .bool(true), "data": payload])
        if let meta { body["meta"] = try TaxValue(encoding: meta) }
        return .init(status: 200, body: try APIBody.encode(body))
    }
}
extension APIRequest {
    fileprivate var path: String { url.path }
    fileprivate var queryItems: [URLQueryItem] {
        URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
    }
    fileprivate var contentType: String { headers.first { $0.key.lowercased() == "content-type" }?.value ?? "" }
}
