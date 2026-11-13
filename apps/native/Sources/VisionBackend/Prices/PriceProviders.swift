import Foundation

/// The provider rules of `services/prices/priceProviderRegistry.ts` that need no network:
/// how an investment's provider settings resolve, how each provider's answer is read, and
/// the Kinesis series repair. The fetching around them waits for the database-bound port.
enum PriceProviders {
    /// The provider columns of an investment (`InvestmentRow`); nil is SQL NULL.
    struct Settings: Equatable, Sendable {
        var name: String?
        var symbol: String?
        // lint:allow raw-id the provider's own symbol text (`price_provider_id`), not a row id
        var providerID: String?
        var url: String?
        var latestURL: String?
        var latestPath: String?
        var historyURL: String?
        var historyPath: String?
        var historyTimestampPath: String?
        var historyPricePath: String?
    }

    /// `CustomHistoryConfig`: where a custom provider's history lives; each path is
    /// dot-separated.
    struct CustomHistory: Equatable, Sendable {
        var historyURL: String
        var historyPath: String
        var timestampPath: String
        var pricePath: String
    }

    struct Kinesis: Equatable, Sendable {
        /// Empty when nothing could be resolved.
        var symbol: String
        var timeframe: Double
        var fromDate: String
        /// The fetched prices are USD and must be converted before use.
        var needsUsdToEur: Bool
    }

    /// `LivePriceQuote`.
    struct Quote: Equatable, Sendable {
        enum Source: String, Sendable { case live, close }
        var price: Double
        var currency: String?  // lint:allow raw-currency the provider's own text, passed through as the TypeScript does
        var source: Source?

        var jsonValue: JSValue {
            var out = JSObject([("price", .number(price))])
            if let currency { out["currency"] = .string(currency) }
            if let source { out["source"] = .string(source.rawValue) }
            return .object(out)
        }
    }

    /// `value || ''` then `.trim()`.
    private static func filled(_ values: String?...) -> String {
        JavaScriptWhitespace.trim(values.compactMap { $0 }.first { !$0.isEmpty } ?? "")
    }

    // MARK: Settings

    /// `resolveYahooSymbol(inv)`: the provider id, else the symbol, upper-cased.
    static func yahooSymbol(_ settings: Settings?) -> String {
        let provider = filled(settings?.providerID)
        if !provider.isEmpty { return JavaScriptCase.uppercased(provider) }
        return JavaScriptCase.uppercased(filled(settings?.symbol))
    }

    /// `_resolveCustomLatestConfig(inv)`.
    static func customLatest(_ settings: Settings?) -> (latestURL: String, latestPath: String) {
        (
            filled(settings?.latestURL, settings?.url, settings?.historyURL),
            filled(settings?.latestPath, settings?.providerID, "price")
        )
    }

    /// `resolveCustomHistoryConfig(inv)`.
    static func customHistory(_ settings: Settings?) -> CustomHistory {
        CustomHistory(
            historyURL: filled(settings?.historyURL, settings?.latestURL, settings?.url),
            historyPath: filled(settings?.historyPath, "points"),
            timestampPath: filled(settings?.historyTimestampPath, "timestamp_ms"),
            pricePath: filled(settings?.historyPricePath, "price"))
    }

    /// Kinesis quotes USD only; a EUR symbol maps to its USD one.
    private static let kinesisEuroSymbols = [
        "KAU_EUR": "KAU_USD", "KAG_EUR": "KAG_USD", "XAU_EUR": "XAU_USD", "XAG_EUR": "XAG_USD", "XPT_EUR": "XPT_USD",
        "XPD_EUR": "XPD_USD",
    ]
    /// `KINESIS_ASSETS` of `config/kinesisConfig.ts`, by asset name.
    private static let kinesisAssets = [
        "kaufen_gold": "KAU_USD", "xau_usd": "XAU_USD", "kaufen_silver": "KAG_USD", "xag_usd": "XAG_USD",
        "xpt_usd": "XPT_USD", "xpd_usd": "XPD_USD",
    ]
    static let kinesisDefaultFromDate = "2019-01-01T08:47:55.843Z"

    /// `resolveKinesisConfig(inv)`, with the environment's default timeframe and start date.
    static func kinesis(
        _ settings: Settings?, defaultTimeframe: Double = 60, defaultFromDate: String = kinesisDefaultFromDate
    ) -> Kinesis {
        let provider = filled(settings?.providerID)
        let named = [settings?.name, settings?.symbol].compactMap { $0 }.first { !$0.isEmpty } ?? ""
        let asset = JavaScriptWhitespace.trim(JavaScriptCase.lowercased(named))
        let mapped = kinesisEuroSymbols.first { BankImportText.same($0.key, provider) }?.value
        var out = Kinesis(
            symbol: mapped ?? provider, timeframe: defaultTimeframe, fromDate: defaultFromDate, needsUsdToEur: mapped != nil)
        if out.symbol.isEmpty, let symbol = kinesisAssets.first(where: { BankImportText.same($0.key, asset) })?.value {
            // Every listed asset states a 60 minute timeframe and the default start date.
            out.symbol = symbol
            out.timeframe = 60
            out.fromDate = kinesisDefaultFromDate
        }
        return out
    }

    // MARK: Paths

    /// `_splitPath(path)`: trimmed, non-empty segments.
    static func segments(_ path: String) -> [String] {
        BankImportText.split(JavaScriptWhitespace.trim(path), ".").map(JavaScriptWhitespace.trim).filter { !$0.isEmpty }
    }

    /// `_readPathValue(input, path)`: an object's own property, an array's element or
    /// `length`, a string's character or `length`. `nil` is `undefined`. The members a
    /// JavaScript value inherits (`constructor`, `toString`, ...) are not reproduced.
    static func read(_ input: JSValue?, _ path: String) -> JSValue? {
        var value = input
        for segment in segments(path) {
            guard let current = value, current != .null else { return nil }
            let position = Int(segment).flatMap { String($0) == segment && $0 >= 0 ? $0 : nil }
            switch current {
            case .object(let object): value = object[segment]
            case .array(let items):
                if segment == "length" { value = .number(Double(items.count)) } else {
                    value = position.flatMap { $0 < items.count ? items[$0] : nil }
                }
            case .string(let text):
                let units = Array(text.utf16)
                if segment == "length" { value = .number(Double(units.count)) } else {
                    value = position.flatMap { $0 < units.count ? .string(String(decoding: [units[$0]], as: UTF16.self)) : nil }
                }
            default: value = nil
            }
        }
        return value
    }

    /// Ascending by timestamp, equal timestamps in their given order (JavaScript's sort is stable).
    private static func sorted(_ points: [PricePoint]) -> [PricePoint] {
        points.enumerated().sorted {
            $0.element.timestampMs < $1.element.timestampMs
                || ($0.element.timestampMs == $1.element.timestampMs && $0.offset < $1.offset)
        }.map(\.element)
    }

    /// `parseCustomHistoryPoints(data, config)`: the rows with a finite timestamp and a finite
    /// price above zero, in date order.
    static func customPoints(_ data: JSValue?, _ config: CustomHistory) -> [PricePoint] {
        guard case .array(let rows)? = read(data, config.historyPath) else { return [] }
        var points: [PricePoint] = []
        for row in rows {
            let timestamp = read(row, config.timestampPath)?.javaScriptNumber ?? .nan
            let price = read(row, config.pricePath)?.javaScriptNumber ?? .nan
            if timestamp.isFinite, price.isFinite, price > 0 { points.append(PricePoint(timestampMs: timestamp, price: price)) }
        }
        return sorted(points)
    }

    // MARK: Kinesis series

    /// `_removeStaleRuns(points)`: of a run of eight or more identical prices only the first
    /// point stays.
    static func removingStaleRuns(_ points: [PricePoint], minimumRun: Int = 8) -> [PricePoint] {
        guard points.count >= 2 else { return points }
        var result: [PricePoint] = []
        var i = 0
        while i < points.count {
            result.append(points[i])
            var j = i + 1
            while j < points.count, points[j].price == points[i].price { j += 1 }
            i = j - i >= minimumRun ? j : i + 1
        }
        return result
    }

    /// `sanitizeKinesisIsolatedSpikes(points)`: stale runs dropped, then a one-point needle
    /// flattened: an edge against its single neighbour, an interior point against the robust
    /// threshold of the series.
    static func sanitizingKinesisSpikes(_ points: [PricePoint]) -> [PricePoint] {
        guard points.count >= 2 else { return points }
        var series = removingStaleRuns(points)
        guard series.count >= 2 else { return series }
        let ratio = 1.8
        let valid = PriceHistory.isValid
        if valid(series[0].price), valid(series[1].price),
            series[0].price * ratio <= series[1].price || series[0].price >= series[1].price * ratio
        {
            series[0].price = series[1].price
        }
        let last = series.count - 1
        if valid(series[last - 1].price), valid(series[last].price),
            series[last].price * ratio <= series[last - 1].price || series[last].price >= series[last - 1].price * ratio
        {
            series[last].price = series[last - 1].price
        }
        guard series.count >= 5 else { return series }
        var logReturns: [Double] = []
        for i in 1..<series.count where valid(series[i - 1].price) && valid(series[i].price) {
            logReturns.append(log(series[i].price / series[i - 1].price))
        }
        guard logReturns.count >= 4 else { return series }
        let statistics = RobustStatistics.returnStatistics(logReturns)
        let tolerance = log(1.12)
        for i in 1..<(series.count - 1) {
            let previous = series[i - 1].price
            let current = series[i].price
            let next = series[i + 1].price
            guard valid(previous), valid(current), valid(next) else { continue }
            let bridge = abs(log(next / previous))
            let peak = current >= max(previous, next) * ratio && bridge <= tolerance
            let trough = current * ratio <= min(previous, next) && bridge <= tolerance
            if RobustStatistics.isNeedle(previous: previous, current: current, next: next, statistics) || peak || trough {
                series[i].price = (previous * next).squareRoot()
            }
        }
        return series
    }

    /// `_parseKinesisTrendlinePoints(rawPoints)`: rows dated by `createdAt`, sanitized. A date
    /// text outside the ISO 8601 forms goes to the engine's own parser in the TypeScript; here
    /// that row is dropped.
    static func kinesisTrendline(_ raw: JSValue?) -> [PricePoint] {
        guard case .array(let rows)? = raw else { return [] }
        var points: [PricePoint] = []
        for row in rows {
            let fields = row.objectValue
            guard let price = PriceHistory.number(fields?["price"]), PriceHistory.isValid(price) else { continue }
            let time: Double?
            switch fields?["createdAt"] {
            case .string(let text)? where !text.isEmpty: time = XLSXWorkbook.isoTime(text)
            case .number(let number)? where number != 0 && !number.isNaN: time = XLSXWorkbook.timeClip(number)
            case .bool(true)?: time = 1
            default: time = nil
            }
            if let time, time.isFinite { points.append(PricePoint(timestampMs: time, price: price)) }
        }
        return sanitizingKinesisSpikes(sorted(points))
    }

    /// `getHistoricalPriceAt(points, timestampMs)`: the last price at or before a moment in a
    /// date-ascending series.
    static func price(in points: [PricePoint], at timestampMs: Double) -> Double? {
        var left = 0
        var right = points.count - 1
        var best: PricePoint?
        while left <= right {
            let middle = (left + right) / 2
            if points[middle].timestampMs <= timestampMs {
                best = points[middle]
                left = middle + 1
            } else {
                right = middle - 1
            }
        }
        return best?.price
    }

    // MARK: Provider answers

    private static func upper(_ ids: [String?]) -> [String] {
        var seen: Set<[UInt16]> = []
        return ids.map { JavaScriptCase.uppercased($0 ?? "") }.filter { !$0.isEmpty && seen.insert(Array($0.utf16)).inserted }
    }

    /// The Binance strategy over one `/ticker/price` answer: a quote per requested symbol the
    /// answer prices. An answer that is not an array prices nothing.
    static func binanceQuotes(_ payload: JSValue?, ids: [String?]) -> [(symbol: String, quote: Quote)] {
        let symbols = upper(ids)
        guard !symbols.isEmpty, case .array(let rows)? = payload else { return [] }
        var prices: [[UInt16]: Double] = [:]
        for row in rows {
            guard let item = row.objectValue, case .string(let symbol)? = item["symbol"], !symbol.isEmpty else { continue }
            let text: String
            switch item["price"] {
            case .string(let value)?: text = value
            case .number(let value)?: text = JavaScriptNumber.text(value)
            default: continue
            }
            let parsed = BankImportText.parseFloat(text)
            if !text.isEmpty, parsed.isFinite, parsed > 0, symbol != "__proto__" { prices[Array(symbol.utf16)] = parsed }
        }
        return symbols.compactMap { symbol in
            prices[Array(symbol.utf16)].map {
                (symbol, Quote(price: $0, currency: symbol.utf16.suffix(3).elementsEqual("EUR".utf16) ? "EUR" : "USD", source: .live))
            }
        }
    }

    /// A `z.number()` leaf of the tolerant Yahoo schemas: a finite number, or absent.
    private static func yahooNumber(_ value: JSValue?) -> JSValue? {
        if case .number(let number)? = value, number.isFinite { return value }
        return value == .null ? .null : nil
    }

    /// The batched part of the Yahoo strategy over one `quote()` answer: the live price, else
    /// the previous close, per symbol. `unresolved` are the symbols the caller asks the chart
    /// endpoint about.
    static func yahooQuotes(_ raw: JSValue?, ids: [String?]) -> (quotes: [(symbol: String, quote: Quote)], unresolved: [String]) {
        let symbols = upper(ids)
        guard !symbols.isEmpty else { return ([], []) }
        let entries: [JSValue]
        switch raw {
        case .array(let items)?: entries = items
        case nil, .null?, .bool(false)?, .number(0)?, .string("")?: entries = []
        case .number(let number)? where number.isNaN: entries = []
        case .some(let single): entries = [single]
        }
        var order: [String] = []
        var quotes: [[UInt16]: Quote] = [:]
        for entry in entries {
            guard let quote = entry.objectValue, case .string(let name)? = quote["symbol"] else { continue }
            let symbol = JavaScriptCase.uppercased(name)
            guard !symbol.isEmpty else { continue }
            var currency = "USD"
            if case .string(let text)? = quote["currency"], !text.isEmpty { currency = text }
            let live = PriceHistory.number(yahooNumber(quote["regularMarketPrice"]))
            let close = PriceHistory.number(yahooNumber(quote["regularMarketPreviousClose"]))
            let found: Quote
            if PriceHistory.isValid(live), let live {
                found = Quote(price: live, currency: currency, source: .live)
            } else if PriceHistory.isValid(close), let close {
                found = Quote(price: close, currency: currency, source: .close)
            } else {
                continue
            }
            if quotes[Array(symbol.utf16)] == nil { order.append(symbol) }
            quotes[Array(symbol.utf16)] = found
        }
        return (
            order.compactMap { symbol in quotes[Array(symbol.utf16)].map { (symbol, $0) } },
            symbols.filter { quotes[Array($0.utf16)] == nil }
        )
    }

    /// The bars of a `chart()` answer (`yahooChartResultSchema`): the objects of `quotes`.
    private static func yahooBars(_ payload: JSValue?) -> [JSObject] {
        guard case .array(let rows)? = payload?.objectValue?["quotes"] else { return [] }
        return rows.compactMap(\.objectValue)
    }

    /// `_fetchYahooLatestClose` over one `chart()` answer: the most recent valid close.
    static func yahooLatestClose(_ payload: JSValue?) -> Double? {
        for bar in yahooBars(payload).reversed() {
            if let close = PriceHistory.number(yahooNumber(bar["close"])), PriceHistory.isValid(close) { return close }
        }
        return nil
    }

    /// The Kinesis strategy over one trendline answer for a symbol whose prices need no
    /// conversion: the latest sanitized price.
    static func kinesisLatest(_ payload: JSValue?, symbol: String) -> Double? {
        guard case .array(let rows)? = payload?.objectValue?[symbol], !rows.isEmpty else { return nil }
        guard let price = kinesisTrendline(.array(rows)).last?.price, PriceHistory.isValid(price) else { return nil }
        return price
    }
}
