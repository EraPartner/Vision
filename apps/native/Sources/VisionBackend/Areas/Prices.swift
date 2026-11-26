import Foundation
import Synchronization
import VisionNativeCore

/// The in-memory price cache and the provider client of `services/prices/priceCache.ts` and
/// `yahooClient.ts`, as one service shared by every prices route of one backend instance (the
/// TypeScript holds them at module level for the same lifetime).
final class PricesService: Sendable {
    /// `PriceCachePayload` of `priceCache.ts`: a live quote (`price`) or a history series
    /// (`points`), with the source that produced it.
    struct Payload: Sendable {
        var price: Double?
        var points: [PricePoint]?
        var source: String?
    }

    private let cache = Mutex<PriceMemoryCache<Payload>>(PriceMemoryCache())
    let yahoo: YahooClient
    let fetcher: any ProviderFetching

    init(fetcher: any ProviderFetching) {
        self.fetcher = fetcher
        self.yahoo = YahooClient(fetcher: fetcher)
    }

    /// `cacheGet(key)`; `Date.now()` is passed by the caller, the fixed clock under replay.
    func cached(_ key: String, now: Double) -> Payload? {
        cache.withLock { $0.get(key, now: now) }
    }

    /// `cacheSet(key, data)`.
    func store(_ key: String, _ payload: Payload, now: Double) {
        cache.withLock { $0.set(key, payload, now: now) }
    }
}

/// `routes/investments.ts` (the `POST /refresh-prices` and `GET /:id/price-history` routes),
/// `services/investmentService.ts` (`refreshPrices`, `getPriceHistory`),
/// `services/priceProviderService.ts` (`fetchLivePricesDetailed`, `fetchHistoricalPrices`)
/// and the `prices/` layer they orchestrate: the provider registry (Binance, Yahoo, custom
/// JSON behind the SSRF guard, Kinesis), `asset_price_history` persistence, and the
/// historical-rate conversion a remapped Kinesis series needs. `listInvestmentProviders` is
/// served by `InvestmentsArea`.
///
/// Bun's 60 s `investmentsCache` over these reads is not ported (ADR-270 decision 4): Swift
/// reads fresh and its refresh leaves no Bun cache stale behind. The provider-health writes
/// of `fetchLivePricesDetailed`'s task runners land in `provider_health` as Bun's do.
enum PricesArea {
    static let timeouts = (binance: 8.0, yahoo: 15.0, custom: 10.0, kinesis: 15.0)
    static let binanceBase = "https://data-api.binance.vision"
    static let kinesisBase = "https://api.kinesis.money/api/market-data/trendlines"
    static let kinesisDefaultTimeframe = 60.0
    static let kinesisDefaultFromDate = "2019-01-01T08:47:55.843Z"

    static func register(
        _ backend: inout InProcessBackend, database: BackendDatabase, service: PricesService
    ) {
        backend.serve(OpenAPIOperations.RefreshInvestmentPrices.self) { _ in
            try await refresh(database: database, service: service)
        }
        backend.serve(OpenAPIOperations.GetInvestmentPriceHistory.self) { request in
            try await history(request, database: database, service: service)
        }
    }

    // MARK: - One investment as the price layer reads it (`mapInvestmentRow`'s provider columns)

    struct Investment: Sendable {
        let id: Int  // lint:allow raw-id `InvestmentRow.id`, a table id the price layer keys maps by
        /// `price_provider`, exactly as stored (nil or "" reads as "manual").
        let provider: String?
        let settings: PriceProviders.Settings
        /// `currency`, exactly as stored.
        let currency: String?
        /// `Number(current_price)`, the stored price `refreshPrices` compares against.
        let currentPrice: Double?

        init(_ row: SQLRow) throws {
            id = try row.integerId("id")
            provider = try row.optionalText("price_provider")
            settings = PriceProviders.Settings(
                name: try row.optionalText("name"),
                symbol: try row.optionalText("symbol"),
                providerID: try row.optionalText("price_provider_id"),
                url: try row.optionalText("price_provider_url"),
                latestURL: try row.optionalText("price_provider_latest_url"),
                latestPath: try row.optionalText("price_provider_latest_path"),
                historyURL: try row.optionalText("price_provider_history_url"),
                historyPath: try row.optionalText("price_provider_history_path"),
                historyTimestampPath: try row.optionalText("price_provider_history_ts_path"),
                historyPricePath: try row.optionalText("price_provider_history_price_path"))
            currency = try row.optionalText("currency")
            currentPrice = try row.optionalDoubleText("current_price")
        }

        /// `investment.price_provider || "manual"`.
        var providerOrManual: String {
            guard let provider, !provider.isEmpty else { return "manual" }
            return provider
        }

        /// `investment.price_provider_id`, exactly as stored.
        var providerID: String? { settings.providerID }  // lint:allow raw-id the provider's own symbol text, not an entity id

    }

    /// `selectInvestmentsWithTickerPref`, the reads' join.
    static let investmentSelect = """
        SELECT i.*, COALESCE(tp.show_in_ticker, 1) AS show_in_ticker \
        FROM investments i LEFT JOIN investment_ticker_prefs tp ON tp.investment_id = i.id
        """

    /// `investmentRepository.getAll({ limit: 1000, active: true })`.
    static func activeInvestments(_ session: BackendSession) throws -> [Investment] {
        try session.rows("\(investmentSelect) WHERE i.is_active = 1 ORDER BY i.name LIMIT 1000")
            .map { try Investment($0) }
    }

    /// `investmentRepository.getById(id)`.
    static func investment(_ session: BackendSession, _ id: InvestmentID) throws -> Investment? {
        try session.row("\(investmentSelect) WHERE i.id = ?", [.integer(Int64(id.rawValue))])
            .map { try Investment($0) }
    }

    /// `hasLivePriceRefreshConfig`.
    static func hasLivePriceRefreshConfig(_ investment: Investment) -> Bool {
        guard let provider = investment.provider, !provider.isEmpty, provider != "manual" else {
            return false
        }
        if provider == "custom" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            return !PriceProviders.customLatest(investment.settings).latestURL.isEmpty
                || !PriceProviders.customHistory(investment.settings).historyURL.isEmpty
        }
        if provider == "yahoo" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            return !(investment.providerID ?? "").isEmpty
                || !(investment.settings.symbol ?? "").isEmpty
        }
        if provider == "kinesis" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            if !(investment.providerID ?? "").isEmpty { return true }
            return !PriceProviders.kinesis(investment.settings).symbol.isEmpty
        }
        return !(investment.providerID ?? "").isEmpty
    }

    // MARK: - POST /refresh-prices (`refreshPrices`)

    static func refresh(database: BackendDatabase, service: PricesService) async throws -> HandlerResult {
        let investments = try await database.run { session in
            try activeInvestments(session)
        }
        let toRefresh = investments.filter(hasLivePriceRefreshConfig)
        if toRefresh.isEmpty {
            return HandlerResult(data: .object([
                "updated": .int(0),
                "message": .string("No investments with live price providers"),
            ]))
        }

        // One instant for the whole refresh, as the recorder's `setSystemTime` pinned it.
        let now = try await database.run { session -> (text: String, ms: Int64) in
            let instant = session.currentInstant()
            return (try SQLTimestamps.formatInstant(instant), instant.ms)
        }
        let nowMs = Double(now.ms)
        let detailed = await livePricesDetailed(
            toRefresh, now: nowMs, service: service, database: database,
            cachedPrices: Dictionary(uniqueKeysWithValues: toRefresh.map { ($0.id, $0.currentPrice ?? 0) }))

        // The collection loop: sources for the whole detailed map, one UPDATE for the live tiers.
        var pricesJSON = JSObject()
        var priceSourcesJSON = JSObject()
        var rowsJSON = ""
        for entry in detailed.entries {
            if entry.price.isNaN { continue }
            pricesJSON[String(entry.id)] = JSValue.number(entry.price)
            priceSourcesJSON[String(entry.id)] = .string(entry.source)
            if entry.source != "cached" && entry.source != "historical_fallback" {
                let row = "{\"id\":\(entry.id),\"current_price\":\(JSValue.string(SQLArguments.javaScriptText(entry.price)).jsonText)"
                    + ",\"price_updated_at\":\(JSValue.string(now.text).jsonText)}"
                rowsJSON += (rowsJSON.isEmpty ? "" : ",") + row
            }
        }
        var updated = 0
        if !rowsJSON.isEmpty {
            let rows = "[\(rowsJSON)]"
            updated = try await database.run { session in
                _ = try session.rows(
                    """
                    UPDATE investments SET current_price = vision_numeric(u.value ->> 'current_price', 18, 6), \
                    price_updated_at = vision_ts(u.value ->> 'price_updated_at'), updated_at = now() \
                    FROM json_each(?) AS u WHERE investments.id = u.value ->> 'id'
                    """,
                    [.text(rows)])
                return Int(try session.row("SELECT changes()")?.int64("changes()") ?? 0)
            }
        }
        let body = JSObject([
            ("updated", .number(Double(updated))),
            ("total", .number(Double(toRefresh.count))),
            ("prices", .object(pricesJSON)),
            ("priceSources", .object(priceSourcesJSON)),
        ])
        return HandlerResult(data: JSValue.object(body).envelopeValue)
    }

    // MARK: - fetchLivePricesDetailed

    /// One resolved price, in `results`' insertion order (`Record<number, ResolvedPrice>`).
    struct ResolvedEntry: Sendable {
        let id: Int  // lint:allow raw-id as above
        let price: Double
        let source: String
    }

    struct Resolved: Sendable {
        var entries: [ResolvedEntry] = []

        mutating func set(_ id: Int, price: Double, source: String) {  // lint:allow raw-id as above
            if !entries.contains(where: { $0.id == id }) {
                entries.append(ResolvedEntry(id: id, price: price, source: source))
            }
        }

        subscript(_ id: Int) -> ResolvedEntry? {  // lint:allow raw-id as above
            entries.first { $0.id == id }
        }
    }

    /// `fetchLivePricesDetailed`: the memory cache, then the four providers, then the stored
    /// price, then the persisted-history fallback, in the TypeScript's order. Provider fetch
    /// failures are swallowed to their log there, so no failure throws here either.
    static func livePricesDetailed(
        _ investments: [Investment], now: Double, service: PricesService, database: BackendDatabase,
        cachedPrices: [Int: Double]  // lint:allow raw-id investment ids, as above
    ) async -> Resolved {
        var results = Resolved()
        var staleBinance: [Investment] = []
        var staleYahoo: [Investment] = []
        var staleCustom: [Investment] = []
        var staleKinesis: [Investment] = []
        for investment in investments {
            let provider = investment.providerOrManual
            if provider == "manual" { continue }  // lint:allow string-literal-compare the recorded provider name, from the investment column

            let providerKey = provider == "yahoo"  // lint:allow string-literal-compare the recorded provider name, from the investment column
                ? PriceProviders.yahooSymbol(investment.settings)
                : (investment.providerID ?? "")
            if providerKey.isEmpty && provider != "custom" && provider != "kinesis" { continue }

            let cacheKey = provider == "custom" || provider == "kinesis"  // lint:allow string-literal-compare the recorded provider name, from the investment column
                ? "\(provider):\(investment.id)"
                : "\(provider):\(providerKey)"
            if let cached = service.cached(cacheKey, now: now), let cachedPrice = cached.price,
                PriceHistory.isValid(cachedPrice)
            {
                results.set(investment.id, price: cachedPrice, source: cached.source ?? "live")
                continue
            }
            switch provider {
            case "binance": staleBinance.append(investment)  // lint:allow string-literal-compare the recorded provider name, from the investment column
            case "yahoo": staleYahoo.append(investment)  // lint:allow string-literal-compare the recorded provider name, from the investment column
            case "custom": staleCustom.append(investment)  // lint:allow string-literal-compare the recorded provider name, from the investment column
            case "kinesis": staleKinesis.append(investment)  // lint:allow string-literal-compare the recorded provider name, from the investment column
            default: break
            }
        }

        // The task runners' order: the id-based providers first, then the investment-based
        // ones. Their task bodies never throw (every failure is caught inside), so each one
        // records a provider-health success exactly as `runProviderTask` does.
        if !staleBinance.isEmpty {
            let quotes = await binanceQuotes(over: staleBinance, service: service)
            for investment in staleBinance {
                let pid = binanceID(investment)
                if let quote = quotes[pid] {
                    results.set(investment.id, price: quote.price, source: (quote.source ?? .live).rawValue)
                    service.store(
                        "binance:\(pid)",
                        PricesService.Payload(
                            price: quote.price, points: nil, source: (quote.source ?? .live).rawValue),
                        now: now)
                }
            }
            await recordHealth(database, "binance", succeeded: true, message: "")
        }
        if !staleYahoo.isEmpty {
            let quotes = await yahooQuotes(over: staleYahoo, now: now, service: service)
            for investment in staleYahoo {
                let pid = PriceProviders.yahooSymbol(investment.settings)
                if let quote = quotes[pid] {
                    results.set(investment.id, price: quote.price, source: (quote.source ?? .live).rawValue)
                    service.store(
                        "yahoo:\(pid)",
                        PricesService.Payload(
                            price: quote.price, points: nil, source: (quote.source ?? .live).rawValue),
                        now: now)
                }
            }
            await recordHealth(database, "yahoo", succeeded: true, message: "")
        }
        if !staleCustom.isEmpty {
            let quotes = await customQuotes(over: staleCustom, service: service)
            for investment in staleCustom {
                if let price = quotes[investment.id], PriceHistory.isValid(price) {
                    results.set(investment.id, price: price, source: "live")
                    service.store(
                        "custom:\(investment.id)",
                        PricesService.Payload(price: price, points: nil, source: "live"), now: now)
                }
            }
        }
        if !staleKinesis.isEmpty {
            let quotes = await kinesisQuotes(over: staleKinesis, service: service, database: database)
            for investment in staleKinesis {
                if let quote = quotes[investment.id], PriceHistory.isValid(quote.price) {
                    results.set(investment.id, price: quote.price, source: "live")
                    service.store(
                        "kinesis:\(investment.id)",
                        PricesService.Payload(price: quote.price, points: nil, source: "live"), now: now)
                }
            }
            await recordHealth(database, "kinesis", succeeded: true, message: "")
        }

        // The stored-price tier, then the offline fallback.
        for investment in investments where results[investment.id] == nil {
            let cachedPrice = cachedPrices[investment.id] ?? Double.nan
            if PriceHistory.isValid(cachedPrice) {
                results.set(investment.id, price: cachedPrice, source: "cached")
            }
        }
        let fallbackIDs: [Int] = investments.filter {  // lint:allow raw-id as above
            results[$0.id] == nil && $0.providerOrManual != "manual"
        }.map { $0.id }
        if !fallbackIDs.isEmpty {
            let latest = try? await database.run { session in
                try latestStoredPoints(session, fallbackIDs)
            }
            for id in fallbackIDs {
                if let entry = latest?[id], let price = entry.price, PriceHistory.isValid(price) {
                    results.set(id, price: price, source: "historical_fallback")
                }
            }
        }
        return results
    }

    /// `runProviderTask`'s `recordProviderSuccess` (kind `price`); a failed write, like a
    /// failed fetch, is only logged there.
    static func recordHealth(
        _ database: BackendDatabase, _ provider: String, succeeded: Bool, message: String
    ) async {
        _ = try? await database.run { session in
            try recordProviderHealth(session, provider, succeeded: succeeded, message: message)
        }
    }

    /// `recordSuccess` / `recordError` of `providerHealthService` for a price provider; the
    /// registry knows no `custom` provider, so that task records nothing.
    static func recordProviderHealth(
        _ session: BackendSession, _ provider: String, succeeded: Bool, message: String
    ) throws {
        guard provider == "binance" || provider == "yahoo" || provider == "kinesis" else { return }  // lint:allow string-literal-compare the recorded provider name, from the investment column
        if succeeded {
            try session.rows(
                """
                INSERT INTO provider_health (provider, kind, last_success_at, consecutive_failures, updated_at) \
                VALUES (?, 'price', now(), 0, now()) ON CONFLICT (provider) DO UPDATE SET \
                last_success_at = now(), consecutive_failures = 0, updated_at = now()
                """, [.text(provider)])
        } else {
            try session.rows(
                """
                INSERT INTO provider_health (provider, kind, last_error_at, last_error, \
                consecutive_failures, updated_at) VALUES (?, 'price', now(), ?, 1, now()) \
                ON CONFLICT (provider) DO UPDATE SET last_error_at = now(), last_error = ?, \
                consecutive_failures = provider_health.consecutive_failures + 1, updated_at = now()
                """, [.text(provider), .text(message), .text(message)])
        }
    }

    // MARK: - The live strategies (`PROVIDERS`)

    /// The raw Binance id of an investment, uppercased (`(inv.price_provider_id || "").toUpperCase()`).
    static func binanceID(_ investment: Investment) -> String {
        JavaScriptCase.uppercased(investment.providerID ?? "")
    }

    /// `PROVIDERS.binance` over one bucket: the batched `/ticker/price` answer. Its internal
    /// catch answers an empty map, so a fetch failure never surfaces to the task runner.
    static func binanceQuotes(
        over bucket: [Investment], service: PricesService
    ) async -> [String: PriceProviders.Quote] {
        var ids: [String?] = []
        for investment in bucket {
            let symbol = binanceID(investment)
            if !symbol.isEmpty && !ids.contains(where: { $0 == symbol }) { ids.append(symbol) }
        }
        guard !ids.isEmpty,
            let url = URL(string: "\(binanceBase)/api/v3/ticker/price"),
            let response = try? await service.fetcher.get(url, timeout: timeouts.binance),
            response.ok,
            let payload = JSValue.parse(response.body)
        else { return [:] }
        var quotes: [String: PriceProviders.Quote] = [:]
        for (symbol, quote) in PriceProviders.binanceQuotes(payload, ids: ids) {
            quotes[symbol] = quote
        }
        return quotes
    }

    /// `PROVIDERS.yahoo` over one bucket: the batched quote (a failure only logs) and the
    /// per-symbol chart fallback every unresolved symbol gets.
    static func yahooQuotes(
        over bucket: [Investment], now: Double, service: PricesService
    ) async -> [String: PriceProviders.Quote] {
        var ids: [String?] = []
        for investment in bucket {
            let symbol = PriceProviders.yahooSymbol(investment.settings)
            if !symbol.isEmpty && !ids.contains(symbol) { ids.append(symbol) }
        }
        guard !ids.isEmpty else { return [:] }

        var quotes: [String: PriceProviders.Quote] = [:]
        var resolved: Set<String> = []
        let batch = try? await service.yahoo.quote(symbols: ids.compactMap { $0 }, nowMs: now)
        for (symbol, quote) in PriceProviders.yahooQuotes(batch, ids: ids).quotes {
            quotes[symbol] = quote
            resolved.insert(symbol)
        }
        for symbol in ids.compactMap({ $0 }) where !resolved.contains(symbol) {
            let payload = try? await service.yahoo.chart(
                symbol: symbol, period1Ms: now - 5 * PriceHistory.dayMs, period2Ms: nil, nowMs: now)
            if let close = PriceProviders.yahooLatestClose(payload), PriceHistory.isValid(close) {
                quotes[symbol] = PriceProviders.Quote(price: close, currency: "USD", source: .close)
            }
        }
        return quotes
    }

    /// `PROVIDERS.custom` over one bucket: the SSRF-guarded latest fetch with its history
    /// fallbacks, keyed by investment id. Every failure is swallowed to the registry's log.
    static func customQuotes(over bucket: [Investment], service: PricesService) async -> [Int: Double] {
        var prices: [Int: Double] = [:]  // lint:allow raw-id investment ids, as above
        for investment in bucket {
            let latest = PriceProviders.customLatest(investment.settings)
            let history = PriceProviders.customHistory(investment.settings)
            var price: Double?
            do {
                if !latest.latestURL.isEmpty {
                    let data = try await fetchJSON(latest.latestURL, service: service)
                    price = PriceHistory.number(PriceProviders.read(data, latest.latestPath))
                    if !PriceHistory.isValid(price), !history.historyURL.isEmpty {
                        if history.historyURL == latest.latestURL {
                            price = PriceProviders.customPoints(data, history).last?.price
                        } else {
                            let historyData = try await fetchJSON(history.historyURL, service: service)
                            price = PriceProviders.customPoints(historyData, history).last?.price
                        }
                    }
                } else if !history.historyURL.isEmpty {
                    let historyData = try await fetchJSON(history.historyURL, service: service)
                    price = PriceProviders.customPoints(historyData, history).last?.price
                }
            } catch {
                if !history.historyURL.isEmpty && history.historyURL != latest.latestURL {
                    if let historyData = try? await fetchJSON(history.historyURL, service: service) {
                        price = PriceProviders.customPoints(historyData, history).last?.price
                    }
                }
            }
            if let price, PriceHistory.isValid(price) {
                prices[investment.id] = price
            }
        }
        return prices
    }

    /// `PROVIDERS.kinesis` over one bucket: the trendline answer, converted at the latest
    /// stored rate when a EUR symbol was remapped to its USD one.
    static func kinesisQuotes(
        over bucket: [Investment], service: PricesService, database: BackendDatabase
    ) async -> [Int: PriceProviders.Quote] {  // lint:allow raw-id investment ids, as above
        var prices: [Int: PriceProviders.Quote] = [:]  // lint:allow raw-id as above
        var latestRates: [String: DecimalJS]? = [:]
        for investment in bucket {
            let config = PriceProviders.kinesis(
                investment.settings,
                defaultTimeframe: kinesisDefaultTimeframe, defaultFromDate: kinesisDefaultFromDate)
            guard !config.symbol.isEmpty,
                let url = URL(
                    string: "\(kinesisBase)?symbolIds=\(requestEncoded(config.symbol))&timeFrame=\(SQLArguments.javaScriptText(config.timeframe))&fromDate=\(config.fromDate)")
            else { continue }
            guard let response = try? await service.fetcher.get(url, timeout: timeouts.kinesis),
                response.ok,
                let payload = JSValue.parse(response.body)
            else { continue }
            guard let usdPrice = PriceProviders.kinesisLatest(payload, symbol: config.symbol),
                PriceHistory.isValid(usdPrice)
            else { continue }

            let currency = AccountsArea.storedCurrencyCode(investment.currency)
            var price = usdPrice
            if config.needsUsdToEur && currency != "USD" {
                if latestRates?.isEmpty ?? true {
                    latestRates = (try? await database.run { session in
                        try AccountsArea.latestRatesToEur(session)
                    }) ?? [:]
                }
                guard let rates = latestRates, let converted = latestConvert(1, "USD", currency, rates)
                else { continue }  // Without a stored rate the quote is skipped, never stored 1:1
                price = converted
            }
            if PriceHistory.isValid(price) {
                prices[investment.id] = PriceProviders.Quote(price: price, currency: currency, source: .live)
            }
        }
        return prices
    }

    /// `convertCodeAtLatestRates(...).toNumber()` through the stored latest rates.
    static func latestConvert(
        _ amount: Double, _ source: String, _ target: String, _ rates: [String: DecimalJS]
    ) -> Double? {
        guard let decimal = try? DecimalJS.from(SQLArguments.javaScriptText(amount)),
            let converted = try? AccountsArea.convert(decimal, from: source, to: target, rates: rates)
        else { return nil }
        return converted.toNumber
    }

    /// `_fetchJson` of `priceProviderRegistry.ts`: the SSRF-guarded GET with manual redirects,
    /// every hop re-validated, at most three followed, the answer JSON-parsed.
    struct UpstreamError: Error, Sendable {
        let message: String
    }

    static func fetchJSON(_ url: String, service: PricesService) async throws -> JSValue {
        var current = url
        for hop in 0...3 {
            _ = try URLSafety.assertPublicHTTP(current, resolve: service.fetcher.resolve)
            guard let fetchURL = URL(string: current),
                let response = try? await service.fetcher.get(fetchURL, timeout: timeouts.custom)
            else { throw UpstreamError(message: "fetch failed: \(current)") }
            if (300..<400).contains(response.status) {
                guard let location = response.headers["location"] else {
                    throw UpstreamError(message: "HTTP \(response.status) redirect without Location")
                }
                if hop >= 3 { throw UpstreamError(message: "too many redirects") }
                guard let next = URL(string: location, relativeTo: fetchURL)?.absoluteString else {
                    throw UpstreamError(message: "Invalid redirect: \(location)")
                }
                current = next
                continue
            }
            guard response.ok else { throw UpstreamError(message: "HTTP \(response.status)") }
            guard let data = JSValue.parse(response.body) else {
                throw UpstreamError(message: "The payload is not JSON")
            }
            return data
        }
        throw UpstreamError(message: "Too many redirects")
    }

    /// `encodeURIComponent`, the custom-provider URL parameters' encoding.
    static func requestEncoded(_ text: String) -> String {
        var out = ""
        for byte in text.utf8 {
            switch byte {
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                UInt8(ascii: "0")...UInt8(ascii: "9"), UInt8(ascii: "-"), UInt8(ascii: "_"),
                UInt8(ascii: "."), UInt8(ascii: "!"), UInt8(ascii: "~"), UInt8(ascii: "*"),
                UInt8(ascii: "'"), UInt8(ascii: "("), UInt8(ascii: ")"):
                out.append(Character(UnicodeScalar(byte)))
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    // MARK: - GET /:id/price-history (`getPriceHistory`)

    static func history(
        _ request: InProcessRequest, database: BackendDatabase, service: PricesService
    ) async throws -> HandlerResult {
        let id = try InvestmentsArea.pathId(request)
        let investment = try await database.run { session in
            try PricesArea.investment(session, id)
        }
        guard let investment else { throw BackendHTTPError.notFound("Investment not found") }

        let from = queryMs(request, "from_ms")
        let to = queryMs(request, "to_ms")
        let now = try await database.run { session in session.currentInstant() }
        let points = try await historicalPoints(
            investment, from: from, to: to,
            dbOnly: QueryInput.boolean(request.query("db_only"), default: true),
            force: false, now: Double(now.ms), database: database, service: service)

        return HandlerResult(data: .object([
            "investment_id": .int(id.rawValue),
            "provider": investment.provider.map(JSONValue.string) ?? .null,
            "points": .array(points.map { $0.jsonValue.envelopeValue }),
        ]))
    }

    /// `Number(req.query.<bound>)` of a possibly repeated parameter: absent, and every value
    /// JavaScript reads NaN from, mean "no bound" (`fetchHistoricalPrices`' own re-read).
    static func queryMs(_ request: InProcessRequest, _ name: String) -> Double? {
        guard let raw = request.query(name) else { return nil }
        let number = JSValue.string(raw).javaScriptNumber
        return number.isFinite ? number : nil
    }

    // MARK: - fetchHistoricalPrices

    /// `fetchHistoricalPrices(investment, { fromMs, toMs, dbOnly, force })`, its db_only
    /// default applied by the caller.
    static func historicalPoints(
        _ investment: Investment, from: Double?, to: Double?, dbOnly: Bool, force: Bool,
        now: Double, database: BackendDatabase, service: PricesService
    ) async throws -> [PricePoint] {
        let provider = investment.providerOrManual
        let cached = try await database.run { session in
            try storedPoints(session, investment.id, from: from, to: to)
        }
        if dbOnly {
            if provider == "kinesis" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
                return filter(PriceProviders.sanitizingKinesisSpikes(cached), from: from, to: to)
            }
            return filter(cached, from: from, to: to)
        }

        let stale = try PriceHistory.needsRefresh(
            PriceHistory.jsPoints(cached), from: from.map(JSValue.number), to: to.map(JSValue.number))
        if !force && !stale {
            if provider == "kinesis" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
                let sanitized = PriceProviders.sanitizingKinesisSpikes(cached)
                let changed = PriceHistory.changedPrices(
                    PriceHistory.jsPoints(cached), PriceHistory.jsPoints(sanitized))
                if changed > 0 {
                    _ = try? await database.run { session in
                        try storePoints(session, investment.id, sanitized, "kinesis")
                    }
                }
                return filter(sanitized, from: from, to: to)
            }
            return filter(cached, from: from, to: to)
        }

        if provider == "yahoo" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            let symbol = PriceProviders.yahooSymbol(investment.settings)
            guard !symbol.isEmpty else { return [] }
            let startDay = Int(((from ?? now - 5 * 365 * PriceHistory.dayMs) / PriceHistory.dayMs).rounded(.down))
            let endDay = Int(((to ?? now) / PriceHistory.dayMs).rounded(.down))
            let cacheKey = "yahoo-history:\(symbol):\(startDay):\(endDay)"
            var points = service.cached(cacheKey, now: now)?.points
            if points == nil {
                do {
                    let payload = try await service.yahoo.chart(
                        symbol: symbol, period1Ms: Double(startDay) * PriceHistory.dayMs,
                        period2Ms: Double(endDay + 1) * PriceHistory.dayMs, nowMs: now)
                    points = try chartPoints(payload)
                    service.store(
                        cacheKey, PricesService.Payload(price: nil, points: points ?? [], source: "live"),
                        now: now)
                } catch {
                    return filter(cached, from: from, to: to)
                }
            }
            return try await persistAndResolve(
                investment.id, points ?? [], "yahoo", cached, from: from, to: to, database: database)
        }

        if provider == "binance" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            let symbol = binanceHistorySymbol(investment)
            guard !symbol.isEmpty else { return [] }
            let startMs = from ?? now - 365 * PriceHistory.dayMs
            let endMs = to ?? now
            let cacheKey = "binance-history:\(symbol):\(Int((startMs / PriceHistory.dayMs).rounded(.down))):\(Int((endMs / PriceHistory.dayMs).rounded(.down)))"
            var points = service.cached(cacheKey, now: now)?.points
            if points == nil {
                do {
                    let klines = try await binanceKlines(symbol, start: startMs, end: endMs, service: service)
                    var bare: [PricePoint] = []
                    for kline in klines {
                        let timestamp = kline.first?.javaScriptNumber ?? .nan
                        let price = kline.count > 4 ? PriceHistory.number(kline[4]) : nil
                        if timestamp.isFinite, PriceHistory.isValid(price), let price {
                            bare.append(PricePoint(timestampMs: timestamp, price: price))
                        }
                    }
                    points = try PriceHistory.normalize(bare)
                    service.store(
                        cacheKey, PricesService.Payload(price: nil, points: points ?? [], source: "live"),
                        now: now)
                } catch {
                    return filter(cached, from: from, to: to)
                }
            }
            return try await persistAndResolve(
                investment.id, points ?? [], "binance", cached, from: from, to: to, database: database)
        }

        if provider == "kinesis" {  // lint:allow string-literal-compare the recorded provider name, from the investment column
            let config = PriceProviders.kinesis(
                investment.settings,
                defaultTimeframe: kinesisDefaultTimeframe, defaultFromDate: kinesisDefaultFromDate)
            guard !config.symbol.isEmpty else { return filter(cached, from: from, to: to) }
            let cacheKey = "kinesis-history:\(config.symbol):\(SQLArguments.javaScriptText(config.timeframe))"
            var points = service.cached(cacheKey, now: now)?.points
            if points == nil {
                guard let url = URL(
                    string: "\(kinesisBase)?symbolIds=\(requestEncoded(config.symbol))&timeFrame=\(SQLArguments.javaScriptText(config.timeframe))&fromDate=\(config.fromDate)"),
                    let response = try? await service.fetcher.get(url, timeout: timeouts.kinesis),
                    response.ok,
                    let payload = JSValue.parse(response.body)
                else { return filter(cached, from: from, to: to) }
                points = PriceProviders.kinesisTrendline(payload.objectValue?[config.symbol])
                service.store(
                    cacheKey, PricesService.Payload(price: nil, points: points ?? [], source: "live"),
                    now: now)
            }
            return try await convertKinesisHistory(
                points ?? [], investment, cached, from: from, to: to, needsUsdToEur: config.needsUsdToEur,
                database: database)
        }

        if provider != "custom" {
            return filter(cached, from: from, to: to)
        }

        // The custom strategy: the guarded history fetch, its cache and its persistence.
        let config = PriceProviders.customHistory(investment.settings)
        guard !config.historyURL.isEmpty else { return [] }
        let cacheKey = "custom-history:\(investment.id):\(config.historyURL):\(config.historyPath):\(config.timestampPath):\(config.pricePath)"
        var points = service.cached(cacheKey, now: now)?.points
        if points == nil {
            do {
                let data = try await fetchJSON(config.historyURL, service: service)
                points = try PriceHistory.normalize(PriceProviders.customPoints(data, config))
                service.store(
                    cacheKey, PricesService.Payload(price: nil, points: points ?? [], source: "live"),
                    now: now)
            } catch {
                return filter(cached, from: from, to: to)
            }
        }
        return try await persistAndResolve(
            investment.id, points ?? [], "custom", cached, from: from, to: to, database: database)
    }

    /// `filterPointsByRange(points, { fromMs, toMs })`.
    static func filter(_ points: [PricePoint], from: Double?, to: Double?) -> [PricePoint] {
        PriceHistory.filter(points, from: from.map(JSValue.number), to: to.map(JSValue.number))
    }

    /// The Binance symbol of a historical window (`(provider_id || "").trim().toUpperCase()`,
    /// the stable-quote suffix deciding the pair).
    static func binanceHistorySymbol(_ investment: Investment) -> String {
        let symbol = JavaScriptCase.uppercased(JavaScriptWhitespace.trim(investment.providerID ?? ""))
        let suffixes = ["EUR", "USDT", "USDC", "BUSD", "BTC", "ETH"]
        if suffixes.contains(where: { symbol.hasSuffix($0) }) { return symbol }
        return symbol.isEmpty ? "" : "\(symbol)USDT"
    }

    /// `normalizeHistoryPoints` of a `chart()` answer's bars (`fetchHistoricalPrices`' Yahoo
    /// branch): one point per bar that survives validation.
    static func chartPoints(_ payload: JSValue) throws -> [PricePoint] {
        guard case .array(let bars)? = payload.objectValue?["quotes"] else { return [] }
        var points: [PricePoint] = []
        for bar in bars {
            guard let fields = bar.objectValue else { continue }
            let timestamp = fields["date"]?.javaScriptNumber ?? .nan
            let price = PriceHistory.number(fields["close"])
            if timestamp.isFinite, PriceHistory.isValid(price), let price {
                points.append(PricePoint(timestampMs: timestamp, price: price))
            }
        }
        return try PriceHistory.normalize(points)
    }

    /// `_fetchBinanceKlines`: the daily-candle walk over the window, paginating past the
    /// 1000-row answer limit.
    static func binanceKlines(
        _ symbol: String, start: Double, end: Double, service: PricesService
    ) async throws -> [[JSValue]] {
        var collected: [[JSValue]] = []
        var cursor = start
        for _ in 0..<30 {
            let url = "\(binanceBase)/api/v3/klines?symbol=\(requestEncoded(symbol))&interval=1d"
                + "&startTime=\(SQLArguments.javaScriptText(cursor))&endTime=\(SQLArguments.javaScriptText(end))&limit=1000"
            guard let fetchURL = URL(string: url),
                let response = try? await service.fetcher.get(fetchURL, timeout: timeouts.binance)
            else { throw UpstreamError(message: "fetch failed: \(url)") }
            guard response.ok else {
                throw UpstreamError(message: "Binance API error: \(response.status)")
            }
            guard let data = JSValue.parse(response.body)?.arrayValue else { return collected }
            if data.isEmpty { return collected }
            collected += data.compactMap { row in
                if case .array(let kline) = row { return kline }
                return nil
            }
            if data.count < 1000 { return collected }
            let lastOpen = data.last?.arrayValue?.first?.javaScriptNumber ?? .nan
            guard lastOpen.isFinite else { return collected }
            let next = lastOpen + PriceHistory.dayMs
            if next > end { return collected }
            cursor = next
        }
        return collected
    }

    /// The remapped Kinesis series' per-point USD conversion (`convertRowsToEur` with
    /// `useHistoricalRatesByDate`): without the stored latest USD and target rates the stored
    /// history wins, a point with no rate at its day is dropped, and both sides fall back to
    /// the latest stored rate when the day has no historical row.
    static func convertKinesisHistory(
        _ points: [PricePoint], _ investment: Investment, _ cached: [PricePoint],
        from: Double?, to: Double?, needsUsdToEur: Bool, database: BackendDatabase
    ) async throws -> [PricePoint] {
        let currency = AccountsArea.storedCurrencyCode(investment.currency)
        guard needsUsdToEur, currency != "USD", !points.isEmpty else {
            return try await persistAndResolve(
                investment.id, points, "kinesis", cached, from: from, to: to, database: database)
        }
        let latest: [String: DecimalJS]
        let index: [String: [(day: String, rate: Double)]]
        do {
            latest = try await database.run { session in
                try AccountsArea.latestRatesToEur(session)
            }
            guard latestConvert(1, "USD", currency, latest) != nil else {
                // The stored series wins over persisting USD prices 1:1.
                return filter(cached, from: from, to: to)
            }
            index = try await database.run { session in
                try historicalRateIndex(session, currencies: ["USD", currency])
            }
        } catch {
            return filter(cached, from: from, to: to)
        }
        var converted: [PricePoint] = []
        for point in points {
            let day = try PriceHistory.dateOnly(point.timestampMs)
            let fromRate = day.flatMap { findRate(index, "USD", $0) } ?? latest["USD"]?.toNumber
            let toRate = day.flatMap { findRate(index, currency, $0) } ?? latest[currency]?.toNumber
            guard let fromRate, let toRate, fromRate != 0, toRate != 0 else { continue }
            converted.append(
                PricePoint(timestampMs: point.timestampMs, price: point.price * fromRate / toRate))
        }
        return try await persistAndResolve(
            investment.id, converted, "kinesis", cached, from: from, to: to, database: database)
    }

    /// `buildHistoricalRateIndex` + `findRateOnOrBeforeInIndex`: one query's rows, per
    /// currency in day order, searched for the rate on or before a day.
    static func historicalRateIndex(
        _ session: BackendSession, currencies: [String]
    ) throws -> [String: [(day: String, rate: Double)]] {
        let unique = currencies.map { AccountsArea.storedCurrencyCode($0) }.filter { $0 != "EUR" }
        guard !unique.isEmpty else { return [:] }
        let codes = JSValue.array(unique.map { .string($0) }).jsonText
        let rows = try session.rows(
            """
            SELECT currency_code, CAST(rate_date AS TEXT) AS rate_date, rate_to_eur FROM exchange_rates \
            WHERE currency_code IN (SELECT value FROM json_each(?)) ORDER BY currency_code ASC, rate_date ASC
            """,
            [.text(codes)])
        var index: [String: [(day: String, rate: Double)]] = [:]
        for row in rows {
            guard let currency = try row.optionalText("currency_code")?.uppercased(),
                let day = try row.optionalText("rate_date"),
                !day.isEmpty, let text = try row.optionalText("rate_to_eur")
            else { continue }
            let rate = JavaScriptNumber.fromString(text)
            guard rate.isFinite else { continue }
            index[currency, default: []].append((day, rate))
        }
        return index
    }

    /// `findRateOnOrBeforeInIndex`: the rate on or before `day`, nil when none exists.
    static func findRate(
        _ index: [String: [(day: String, rate: Double)]], _ currency: String, _ day: String
    ) -> Double? {
        guard let entries = index[currency] else { return nil }
        var lo = 0
        var hi = entries.count - 1
        while lo <= hi {
            let mid = (lo + hi) / 2
            if entries[mid].day == day { return entries[mid].rate }
            if entries[mid].day < day { lo = mid + 1 } else { hi = mid - 1 }
        }
        return hi >= 0 ? entries[hi].rate : nil
    }

    /// `_persistAndResolve`: persist the in-window points with the source, then answer the
    /// persisted series, or the normalized union when nothing survived persistence.
    static func persistAndResolve(
        _ id: Int, _ points: [PricePoint], _ source: String, _ cached: [PricePoint],
        from: Double?, to: Double?, database: BackendDatabase
    ) async throws -> [PricePoint] {  // lint:allow raw-id investment ids, as above
        let inWindow = filter(points, from: from, to: to)
        try await database.run { session in
            try storePoints(session, id, inWindow, source)
        }
        let persisted = try await database.run { session in
            try storedPoints(session, id, from: from, to: to)
        }
        let resolved = !persisted.isEmpty ? persisted : try PriceHistory.normalize(cached + inWindow)
        return filter(resolved, from: from, to: to)
    }

    // MARK: - asset_price_history persistence (`priceCache.ts`)

    /// `loadHistoricalPointsFromDatabase`: the day-bounded rows, normalized.
    static func storedPoints(
        _ session: BackendSession, _ id: Int, from: Double?, to: Double?  // lint:allow raw-id as above
    ) throws -> [PricePoint] {
        var sql = "SELECT price_date, close_price FROM asset_price_history WHERE investment_id = ?"
        var arguments: [SQLValue] = [.integer(Int64(id))]
        if let from, from.isFinite, let fromDay = try PriceHistory.dateOnly(from) {
            sql += " AND price_date >= ?"
            arguments.append(.text(fromDay))
        }
        if let to, to.isFinite, let toDay = try PriceHistory.dateOnly(to) {
            sql += " AND price_date <= ?"
            arguments.append(.text(toDay))
        }
        sql += " ORDER BY price_date ASC"
        let rows = try session.rows(sql, arguments)
        var points: [PricePoint] = []
        for row in rows {
            points.append(
                PricePoint(
                    timestampMs: PriceHistory.noon(try row.text("price_date")),
                    price: JavaScriptNumber.fromString(try row.optionalText("close_price") ?? "")))
        }
        return try PriceHistory.normalize(points)
    }

    /// `loadLatestHistoricalPointByInvestmentIds`: the newest persisted point per investment.
    static func latestStoredPoints(  // lint:allow raw-id as above
        _ session: BackendSession, _ ids: [Int]
    ) throws -> [Int: (timestampMs: Double, price: Double?)] {
        var unique: [Int] = []  // lint:allow raw-id as above
        for id in ids where !unique.contains(id) { unique.append(id) }
        guard !unique.isEmpty else { return [:] }
        let idsJSON = "[\(unique.map(String.init).joined(separator: ","))]"
        let rows = try session.rows(
            """
            SELECT investment_id, price_date, close_price FROM \
            (SELECT investment_id, price_date, close_price, \
             row_number() OVER (PARTITION BY investment_id ORDER BY price_date DESC) AS rn \
             FROM asset_price_history WHERE investment_id IN (SELECT value FROM json_each(?))) \
            WHERE rn = 1 ORDER BY investment_id
            """,
            [.text(idsJSON)])
        var latest: [Int: (timestampMs: Double, price: Double?)] = [:]  // lint:allow raw-id as above
        for row in rows {
            latest[try row.integerId("investment_id")] = (
                timestampMs: PriceHistory.noon(try row.text("price_date")),
                price: try row.optionalText("close_price").map { JavaScriptNumber.fromString($0) }
            )
        }
        return latest
    }

    /// `saveHistoricalPointsToDatabase`: one `json_each` upsert of the points that survive
    /// normalization, rewriting only the rows whose price or source changed.
    static func storePoints(
        _ session: BackendSession, _ id: Int, _ points: [PricePoint], _ source: String?
    ) throws {  // lint:allow raw-id as above
        let normalized = try PriceHistory.normalize(points)
        guard !normalized.isEmpty else { return }
        var rowsJSON = ""
        for point in normalized {
            guard let day = try PriceHistory.dateOnly(point.timestampMs), PriceHistory.isValid(point.price)
            else { continue }
            let row = "{\"d\":\(JSValue.string(day).jsonText),\"p\":\(JSValue.string(SQLArguments.javaScriptText(point.price)).jsonText)}"
            rowsJSON += (rowsJSON.isEmpty ? "" : ",") + row
        }
        guard !rowsJSON.isEmpty else { return }
        let sourceText = source.flatMap { $0.isEmpty ? nil : $0 } ?? "provider"
        _ = try session.rows(
            """
            INSERT INTO asset_price_history (investment_id, price_date, close_price, source) \
            SELECT ?, p.value ->> 'd', vision_numeric(p.value ->> 'p', 18, 6), ? \
            FROM json_each(?) AS p WHERE true \
            ON CONFLICT (investment_id, price_date) DO UPDATE SET \
              close_price = excluded.close_price, source = excluded.source, \
              fetched_at = now(), updated_at = now() \
            WHERE asset_price_history.close_price IS NOT excluded.close_price \
               OR asset_price_history.source IS NOT excluded.source
            """,
            [.integer(Int64(id)), .text(sourceText), .text("[\(rowsJSON)]")])
    }
}

extension PriceHistory {
    /// The `PricePoint[]` a caller passes to a JSValue-taking helper of the pure core.
    static func jsPoints(_ points: [PricePoint]) -> JSValue {
        .array(points.map { point in
            .object(JSObject([("timestampMs", .number(point.timestampMs)), ("price", .number(point.price))]))
        })
    }
}
