import Foundation

/// One yahoo-finance2 failure (`new Error(...)` the modules throw).
struct YahooError: Error, Sendable {
    let message: String

    init(_ message: String) { self.message = message }
}

/// `services/prices/yahooClient.ts`'s `getYahooClient()` and the yahoo-finance2 calls Vision
/// makes through it: `chart()` (`module-chart.js` with the `return: "array"` transform) for a
/// symbol's daily bars and `quote()` for a batch of live quotes. Only the observable surface
/// is ported: the URLs the module composes (`query2.finance.yahoo.com`, the module's parameter
/// order, `URLSearchParams` encoding, `Math.floor(date/1000)` periods) and the result shapes
/// (`{ meta, quotes }` and the quote array), so an answer served for the composed URL under
/// the TypeScript backend replays identically against this client. The lib's cookie jar and
/// consent-redirect crumb chase are reduced to their error behaviour: any fetch failure fails
/// the call exactly as an unreachable host fails the TypeScript one, and the quote batch needs
/// its crumb first, so a corpus that does not stub crumb URLs keeps the per-symbol chart
/// fallback the batch failure triggers there.
struct YahooClient: Sendable {
    /// `YF_QUERY_HOST`.
    static let queryHost = "query2.finance.yahoo.com"
    static let fetchTimeout = 15.0

    private let fetcher: any ProviderFetching

    init(fetcher: any ProviderFetching) {
        self.fetcher = fetcher
    }

    // MARK: - chart()

    /// `urlSearchParams` serialization of `application/x-www-form-urlencoded`: space is `+`
    /// and only `A–Z a–z 0–9 * - . _` stay literal.
    private static func formEncoded(_ text: String) -> String {
        var out = ""
        for byte in text.utf8 {
            switch byte {
            case UInt8(ascii: " "): out += "+"
            case UInt8(ascii: "*"), UInt8(ascii: "-"), UInt8(ascii: "."), UInt8(ascii: "_"):
                out.append(Character(UnicodeScalar(byte)))
            case UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "a")...UInt8(ascii: "z"),
                UInt8(ascii: "0")...UInt8(ascii: "9"):
                out.append(Character(UnicodeScalar(byte)))
            default:
                out += String(format: "%%%02X", byte)
            }
        }
        return out
    }

    /// `yahooFinance.chart(symbol, { period1, period2?, interval: "1d", includePrePost: false })`:
    /// the module's `transformWith` (the second date defaults to now, `Date`s become
    /// `Math.floor(ms / 1000)`, equal periods throw) then the `return: "array"` result shape.
    func chart(symbol: String, period1Ms: Double, period2Ms: Double?, nowMs: Double) async throws -> JSValue {
        let period1 = Int((period1Ms / 1000).rounded(.down))
        let period2 = Int(((period2Ms ?? nowMs) / 1000).rounded(.down))
        if period1 == period2 {
            throw YahooError(
                "yahooFinance.chart() options `period1` and `period2` cannot share the same value.")
        }
        // `https://${YF_QUERY_HOST}/v8/finance/chart/` + symbol, with the module's defaults in
        // their declared order and the override dates appended by the transform.
        let params: [(String, String)] = [
            ("useYfid", "true"), ("interval", "1d"), ("includePrePost", "false"),
            ("events", "div|split|earn"), ("lang", "en-US"), ("period1", String(period1)),
            ("period2", String(period2)),
        ]
        let query = params.map { Self.formEncoded($0.0) + "=" + Self.formEncoded($0.1) }
            .joined(separator: "&")
        let urlString = "https://\(Self.queryHost)/v8/finance/chart/\(symbol)?\(query)"

        guard let url = URL(string: urlString), let response = try await fetcher.get(url, timeout: Self.fetchTimeout)
        else { throw YahooError("fetch failed: \(urlString)") }
        guard let body = JSValue.parse(response.body)?.objectValue,
            let chartBody = body["chart"]?.objectValue,
            let chart = chartBody["result"]?.arrayValue?.first
        else {
            throw YahooError("Unexpected result: \(body["chart"].map { $0.jsonText } ?? "undefined")")
        }

        // The module's result transform: no timestamp means exactly one empty quote object
        // (an odd answer throws), otherwise the indicator rows pair with the timestamps.
        guard let timestamps = chart["timestamp"]?.arrayValue else {
            let quote = chart["indicators"]?.objectValue?["quote"]?.arrayValue ?? []
            if quote.count != 1 {
                throw YahooError("No timestamp with quotes.length !== 1, please report with your query")
            }
            if let first = quote.first?.objectValue, !first.isEmpty {
                throw YahooError(
                    "No timestamp with unexpected quote, please report with your query\(first.jsonText)")
            }
            return .object(JSObject([("meta", chart["meta"] ?? .null), ("quotes", .array([]))]))
        }

        let indicator = chart["indicators"]?.objectValue?["quote"]?
            .arrayValue?.first?.objectValue
        // The bars' `high` column decides the count check the module makes before building.
        let highs = indicator?["high"]?.arrayValue
        if let highs, highs.count != timestamps.count {
            throw YahooError(
                "Timestamp count mismatch, please report this with the query you used")
        }
        var quotes: [JSValue] = []
        for (index, timestamp) in timestamps.enumerated() {
            var bar = JSObject()
            bar["date"] = .number(timestamp.javaScriptNumber * 1000)
            for field in ["high", "volume", "open", "low", "close"] {
                bar[field] = indicator?[field]?.arrayValue?[index] ?? .null
            }
            quotes.append(.object(bar))
        }
        return .object(JSObject([("meta", chart["meta"] ?? .null), ("quotes", .array(quotes))]))
    }

    // MARK: - quote()

    /// `yahooFinance.quote(symbols)`: the crumb the v7 endpoint needs is chased first (its own
    /// fetch fails the call when unreachable), then `quoteResponse.result` filtered of
    /// `quoteType: "NONE"`.
    func quote(symbols: [String], nowMs: Double) async throws -> JSValue {
        guard let crumbURL = URL(string: "https://finance.yahoo.com/quote/AAPL") else {
            throw YahooError("the crumb URL is not a URL")
        }
        _ = try await fetcher.get(crumbURL, timeout: Self.fetchTimeout)
        guard let url = URL(
            string: "https://\(Self.queryHost)/v7/finance/quote?symbols=\(Self.formEncoded(symbols.joined(separator: ",")))"
        ), let response = try await fetcher.get(url, timeout: Self.fetchTimeout)
        else { throw YahooError("quote fetch failed") }
        guard let body = JSValue.parse(response.body)?.objectValue else {
            throw YahooError("Unexpected result: undefined")
        }
        guard let results = body["quoteResponse"]?.objectValue?["result"]?.arrayValue else {
            throw YahooError("Unexpected result: \(body["quoteResponse"].map { $0.jsonText } ?? "undefined")")
        }
        return .array(results.filter { $0.objectValue?["quoteType"] != .string("NONE") })
    }
}
