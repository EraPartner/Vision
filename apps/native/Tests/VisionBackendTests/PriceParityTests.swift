import Foundation
import Testing

@testable import VisionBackend

/// Replays `parity/plans/prices.jsonl`: the history point rules of `priceCache.ts` and the
/// settings, payload readers and provider strategies of `priceProviderRegistry.ts`, with what
/// the TypeScript answered (`bun run native:parity-plans`). A strategy is given the provider's
/// answer; nothing is fetched.
@Suite struct PriceParityTests {
    static let corpus = PortfolioImportPlanParityTests.corpus
        .deletingLastPathComponent().appendingPathComponent("prices.jsonl")

    private struct UnknownOperation: Error { let name: String }

    private static func number(_ value: Double) -> JSValue {
        value.isFinite ? .number(value) : .string(JavaScriptNumber.text(value))
    }

    private static func points(_ points: [PricePoint]) -> JSValue { .array(points.map(\.jsonValue)) }

    /// Points as a call passes them where the TypeScript takes `PricePoint[]`.
    private static func given(_ value: JSValue?) -> [PricePoint] {
        guard case .array(let items)? = value else { return [] }
        return items.map {
            PricePoint(
                timestampMs: $0.objectValue?["timestampMs"]?.javaScriptNumber ?? .nan,
                price: $0.objectValue?["price"]?.javaScriptNumber ?? .nan)
        }
    }

    private static func settings(_ value: JSValue?) -> PriceProviders.Settings {
        let wire = value?.objectValue
        func text(_ key: String) -> String? { wire?[key]?.stringValue }
        return PriceProviders.Settings(
            name: text("name"), symbol: text("symbol"), providerID: text("price_provider_id"),
            url: text("price_provider_url"), latestURL: text("price_provider_latest_url"),
            latestPath: text("price_provider_latest_path"), historyURL: text("price_provider_history_url"),
            historyPath: text("price_provider_history_path"), historyTimestampPath: text("price_provider_history_ts_path"),
            historyPricePath: text("price_provider_history_price_path"))
    }

    private static func quotes(_ quotes: [(symbol: String, quote: PriceProviders.Quote)]) -> JSValue {
        .object(JSObject(quotes.map { ($0.symbol, $0.quote.jsonValue) }))
    }

    private static let outOfRange = JSValue.object(JSObject([("error", .string("range"))]))

    static func evaluate(_ op: [JSValue]) throws -> JSValue {
        // A recorded `null` stands for an absent argument.
        func at(_ index: Int) -> JSValue? { op.count > index && op[index] != .null ? op[index] : nil }
        func raw(_ index: Int) -> JSValue? { op.count > index ? op[index] : nil }
        let name = op.first?.stringValue ?? ""
        do {
            switch name {
            case "normalize": return points(try PriceHistory.normalize(raw(1)))
            case "filter": return points(PriceHistory.filter(given(at(1)), from: at(2), to: at(3)))
            case "refresh": return .bool(try PriceHistory.needsRefresh(raw(1), from: at(2), to: at(3)))
            case "changed": return .number(Double(PriceHistory.changedPrices(raw(1), raw(2))))
            case "number": return PriceHistory.number(raw(1)).map(JSValue.number) ?? .null
            case "valid": return .bool(PriceHistory.isValid(PriceHistory.number(raw(1))))
            case "dateOnly": return try PriceHistory.dateOnly(raw(1)?.javaScriptNumber ?? .nan).map(JSValue.string) ?? .null
            case "noon": return number(PriceHistory.noon(at(1)?.stringValue ?? ""))
            case "yahooSymbol": return .string(PriceProviders.yahooSymbol(settings(at(1))))
            case "customHistory":
                let config = PriceProviders.customHistory(settings(at(1)))
                return .object(
                    JSObject([
                        ("historyUrl", .string(config.historyURL)), ("historyPath", .string(config.historyPath)),
                        ("timestampPath", .string(config.timestampPath)), ("pricePath", .string(config.pricePath)),
                    ]))
            case "kinesis":
                let config = PriceProviders.kinesis(settings(at(1)))
                return .object(
                    JSObject([
                        ("symbol", .string(config.symbol)), ("timeframe", .number(config.timeframe)),
                        ("fromDate", .string(config.fromDate)), ("needsUsdToEur", .bool(config.needsUsdToEur)),
                    ]))
            case "customPoints":
                let wire = at(2)?.objectValue
                func text(_ key: String) -> String { wire?[key]?.stringValue ?? "" }
                return points(
                    PriceProviders.customPoints(
                        raw(1),
                        .init(
                            historyURL: text("historyUrl"), historyPath: text("historyPath"),
                            timestampPath: text("timestampPath"), pricePath: text("pricePath"))))
            case "spikes": return points(PriceProviders.sanitizingKinesisSpikes(given(at(1))))
            case "trendline": return points(PriceProviders.kinesisTrendline(raw(1)))
            case "priceAt":
                return PriceProviders.price(in: given(at(1)), at: raw(2)?.javaScriptNumber ?? .nan).map(JSValue.number) ?? .null
            case "binance":
                let ids: [String?] = (at(2).flatMap { value -> [JSValue]? in if case .array(let items) = value { return items } else { return nil } } ?? []).map(\.stringValue)
                return quotes(PriceProviders.binanceQuotes(raw(1), ids: ids))
            case "yahoo":
                let ids: [String?] = (at(2).flatMap { value -> [JSValue]? in if case .array(let items) = value { return items } else { return nil } } ?? []).map(\.stringValue)
                let batch = PriceProviders.yahooQuotes(raw(1), ids: ids)
                var found = batch.quotes
                for symbol in batch.unresolved {
                    if let close = PriceProviders.yahooLatestClose(at(3)?.objectValue?[symbol]) {
                        found.append((symbol, PriceProviders.Quote(price: close, currency: "USD", source: .close)))
                    }
                }
                return quotes(found)
            case "kinesisLive":
                let investment = at(1)?.objectValue
                let config = PriceProviders.kinesis(settings(at(1)))
                guard !config.symbol.isEmpty, let price = PriceProviders.kinesisLatest(raw(2), symbol: config.symbol) else {
                    return .object(JSObject())
                }
                let stored = investment?["currency"]?.stringValue ?? ""
                let currency = stored.isEmpty ? "EUR" : JavaScriptCase.uppercased(stored)
                let id = JavaScriptNumber.text(investment?["id"]?.javaScriptNumber ?? .nan)
                return .object(JSObject([(id, PriceProviders.Quote(price: price, currency: currency, source: .live).jsonValue)]))
            default: throw UnknownOperation(name: name)
            }
        } catch is PriceHistory.OutOfRange {
            return outOfRange
        }
    }

    @Test func everyRecordedAnswerIsReproduced() throws {
        let lines = try String(contentsOf: Self.corpus, encoding: .utf8).split(separator: "\n")
        var failures: [String] = []
        var mismatches = 0
        for (index, line) in lines.enumerated() {
            let recorded = try PlanFixture.object(String(line))
            guard case .array(let op)? = recorded["op"] else { continue }
            let got = PlanFixture.canonical(try Self.evaluate(op))
            let want = PlanFixture.canonical(recorded["r"] ?? .null)
            if !got.utf8.elementsEqual(want.utf8) {
                mismatches += 1
                if failures.count < 12 {
                    failures.append(
                        "line \(index + 1) \(String(line.prefix(400)))\n  want \(want.prefix(700))\n  got  \(got.prefix(700))")
                }
            }
        }
        #expect(mismatches == 0, "\(mismatches) of \(lines.count)\n\(failures.joined(separator: "\n"))")
        #expect(lines.count > 300)
    }

    @Test func memoryCacheExpiresAfterFiveMinutes() {
        var cache = PriceMemoryCache<Double>()
        cache.set("yahoo:ACME", 12.5, now: 1000)
        #expect(cache.get("yahoo:ACME", now: 1000 + 300_000) == 12.5)
        #expect(cache.get("yahoo:ACME", now: 1000 + 300_001) == nil)
        #expect(cache.count == 0)
        cache.set("a", 1, now: 0)
        cache.set("b", 2, now: 10)
        #expect(cache.sweep(now: 300_005) == 1)
        #expect(cache.get("b", now: 300_005) == 2)
    }
}
