import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Research Compare URL, server authority, cache and stale scopes")
struct ResearchCompareTests {
    @Test func repeatedSymbolsNormalizeDeduplicateCapAndRetainUnrelatedURLState() throws {
        let route = try #require(
            NativeRoute(
                "/research/compare?symbol=+aapl+&symbol=AAPL&symbol=bad+symbol&symbol=MSFT&symbol=ASML.AS&symbol=BTC-USD&symbol=%5EGSPC&symbol=EURUSD%3DX&symbol=EXTRA&range=bad&tab=bad&sort=bad&keep=yes"
            ))
        let state = ResearchCompareURLState(route: route)
        #expect(state.symbols == ["AAPL", "MSFT", "ASML.AS", "BTC-USD", "^GSPC", "EURUSD=X"])
        #expect(state.range == "1y" && state.tab == "performance" && state.sort == nil)
        #expect(state.adding("NEXT", to: route) == route)
        let removed = state.removing("MSFT", from: route)
        #expect(ResearchCompareURLState(route: removed).symbols == ["AAPL", "ASML.AS", "BTC-USD", "^GSPC", "EURUSD=X"])
        #expect(removed.value("keep") == "yes")
        #expect(state.settingRange("1y", in: route).value("range") == nil)
        #expect(state.settingTab("performance", in: route).value("tab") == "performance")
        for symbol in ["AAPL", "BRK.B", "BTC-USD", "^GSPC", "EURUSD=X", "GC=F", "ABC/DEF", "\u{FEFF} aapl \u{FEFF}"] {
            #expect(ResearchCompareURLState.normalizeSymbol(symbol) != nil)
        }
        #expect(ResearchCompareURLState.normalizeSymbol(String(repeating: "A", count: 33)) == nil)
        #expect(ResearchCompareURLState.normalizeSymbol("bad symbol") == nil)
        #expect(ResearchCompareURLState.normalizeSymbol("\u{0085}AAPL\u{0085}") == nil)
        #expect(ResearchCompareURLState.normalizeSymbol("AAPL\u{0085}") == nil)
        #expect(ResearchCompareURLState.normalizeSymbol("\u{2028} aapl \u{2029}") == "AAPL")
    }
    @Test func nullMetricsStayUnavailableAndWrongSymbolMatricesAreRejected() throws {
        let raw = compareReply(symbols: ["AAPL", "MSFT"], allNull: true)
        let presentation = try ResearchComparePresentation(raw: raw, symbols: ["AAPL", "MSFT"])
        #expect(presentation.stats[0].totalReturn == nil && presentation.correlation[0][1] == nil)
        #expect(presentation.rows[0].values["AAPL"] == nil)
        #expect(throws: APIError.self) { try ResearchComparePresentation(raw: raw, symbols: ["MSFT", "AAPL"]) }
        var invalid = raw
        invalid["result"]?["correlation"]?["matrix"] = .array([.array([.number(1)])])
        #expect(throws: APIError.self) { try ResearchComparePresentation(raw: invalid, symbols: ["AAPL", "MSFT"]) }
    }
    @Test func bothTabsFetchChartAndScorecardOnceAndPreserveRawMetaAndDecimals() async throws {
        let transport = CompareTransport()
        let model = compareModel(transport)
        let route = try #require(NativeRoute("/research/compare?symbol=AAPL&tab=fundamentals"))
        await model.load(route: route)
        #expect(await transport.chartReads == 1)
        #expect(await transport.scorecardReads == 1)
        #expect(model.charts["AAPL"]?.meta.provider == "synthetic")
        #expect(model.fundamentals["AAPL"]?.meta.raw?["opaque"]?.stringValue == "preserved")
        #expect(model.presentation?.stats[0].totalReturn == Decimal(string: "0.1234567890123456789"))
        let submitted = try #require(await transport.presentations.first)
        #expect(
            submitted["series"]?.arrayValue?.first?["points"]?.arrayValue?.first?["close"]
                == .number(Decimal(string: "10.1234567890123456789")!))
        #expect(submitted["series"]?.arrayValue?.first?["points"]?.arrayValue?.first?["time"] == .number(1000))
        await model.load(route: model.selectTab("performance"))
        await model.load(route: model.toggleSort("pe"))
        #expect(await transport.chartReads == 1)
        #expect(await transport.scorecardReads == 1)
        model.didDisappear()
        await model.load(route: route)
        #expect(await transport.chartReads == 1)
        #expect(await transport.scorecardReads == 1)
        await model.load(route: model.selectRange("3mo"))
        #expect(await transport.chartReads == 2)
        #expect(await transport.scorecardReads == 1)
        #expect(model.state.range == "3mo")
    }
    @Test func changedWindowCannotShowOldPointsDuringTheReadOrAcceptLatePresentation() async throws {
        let transport = CompareTransport()
        let model = compareModel(transport)
        await transport.pausePresentation()
        let old = Task {
            await model.load(
                route: NativeRoute(path: "/research/compare", query: [.init(name: "symbol", value: "AAPL")]))
        }
        await transport.waitForPause()
        let next = model.selectRange("3mo")
        #expect(model.presentation == nil && model.charts.isEmpty)
        await model.load(route: next)
        let current = model.presentation
        await transport.release()
        await old.value
        #expect(model.presentation == current && model.state.range == "3mo")
        #expect(model.charts["AAPL"]?.data.points.first?.time == 3000)
    }
    @Test func reconnectWhileHiddenDoesNotStartProviderReadsAndLeavingClearsSearch() async throws {
        let transport = CompareTransport()
        let model = compareModel(transport)
        await model.load(route: NativeRoute(path: "/research/compare", query: [.init(name: "symbol", value: "AAPL")]))
        model.search.searchText = "MSFT"
        model.didDisappear()
        #expect(model.search.searchText.isEmpty && model.search.items.isEmpty && !model.search.isOpen)
        model.isOnline = false
        model.isOnline = true
        for _ in 0..<30 { await Task.yield() }
        #expect(await transport.chartReads == 1)
        #expect(await transport.scorecardReads == 1)
        #expect(await transport.presentations.count == 1)
        #expect(!model.isLoading && !model.isPreparing)
    }
    @Test func performancePublishesWithoutWaitingForPendingScorecards() async throws {
        let transport = CompareTransport()
        await transport.pauseScorecard()
        let model = compareModel(transport)
        let load = Task {
            await model.load(
                route: NativeRoute(path: "/research/compare", query: [.init(name: "symbol", value: "AAPL")]))
        }
        await transport.waitForScorecardPause()
        for _ in 0..<200 {
            if model.presentation != nil { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(model.presentation != nil && !model.isLoading && model.fundamentalsLoading)
        #expect(await transport.presentations.count == 1)
        await transport.releaseScorecard()
        await load.value
        #expect(!model.fundamentalsLoading)
        #expect(await transport.chartReads == 1)
        #expect(await transport.scorecardReads == 1)
        #expect(await transport.presentations.count == 1)
    }
    @Test func unavailableScorecardsRetainMetadataAndDoNotCreateValuesOrGrades() async throws {
        let transport = CompareTransport(unavailable: true)
        let model = compareModel(transport)
        await model.load(route: NativeRoute(path: "/research/compare", query: [.init(name: "symbol", value: "AAPL")]))
        #expect(model.fundamentals["AAPL"]?.data == nil)
        #expect(model.fundamentals["AAPL"]?.meta.source == "unavailable")
        #expect(model.fundamentals["AAPL"]?.meta.provider == "synthetic")
        #expect(!model.fundamentalsLoading && !model.isLoading)
    }
    @Test func metricSortingIsStableWithMissingValuesLastAndClearsOnSecondClick() async throws {
        let model = compareModel(CompareTransport())
        let route = NativeRoute(
            path: "/research/compare",
            query: [
                .init(name: "symbol", value: "MSFT"), .init(name: "symbol", value: "AAPL"),
                .init(name: "symbol", value: "NODATA"),
            ])
        await model.load(route: route)
        _ = model.toggleSort("pe")
        #expect(model.sortedFundamentalsSymbols == ["AAPL", "MSFT", "NODATA"])
        _ = model.toggleSort("pe")
        #expect(model.sortedFundamentalsSymbols == ["MSFT", "AAPL", "NODATA"])
        #expect(model.state.sort == nil)
    }
    private func compareModel(_ transport: CompareTransport) -> ResearchCompareModel {
        ResearchCompareModel(
            service: APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0))
    }
}

private func compareReply(symbols: [String], allNull: Bool = false) -> TaxValue {
    .object([
        "kind": .string("compare"),
        "result": .object([
            "rows": .array([
                .object(
                    Dictionary(
                        uniqueKeysWithValues: [("time", TaxValue.number(1000))]
                            + symbols.map { ($0, allNull ? .null : .number(100)) }))
            ]),
            "stats": .array(
                symbols.map {
                    .object([
                        "symbol": .string($0),
                        "totalReturn": allNull ? .null : .number(Decimal(string: "0.1234567890123456789")!),
                        "volatility": allNull ? .null : .number(Decimal(string: "0.2")!),
                        "maxDrawdown": allNull ? .null : .number(Decimal(string: "-0.3")!),
                        "firstTime": .number(1000), "lastTime": .number(2000),
                    ])
                }),
            "correlation": .object([
                "symbols": .array(symbols.map(TaxValue.string)),
                "matrix": .array(
                    symbols.indices.map { i in .array(symbols.indices.map { j in i == j ? .number(1) : .null }) }),
            ]),
        ]),
    ])
}
private actor CompareTransport: APITransport {
    private(set) var chartReads = 0
    private(set) var scorecardReads = 0
    private(set) var presentations: [TaxValue] = []
    private let unavailable: Bool
    private var pause = false
    private var paused: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    private var scorecardPause = false
    private var pausedScorecard: CheckedContinuation<Void, Never>?
    private var enteredScorecard: CheckedContinuation<Void, Never>?
    init(unavailable: Bool = false) { self.unavailable = unavailable }
    func pausePresentation() { pause = true }
    func pauseScorecard() { scorecardPause = true }
    func waitForScorecardPause() async {
        if pausedScorecard == nil { await withCheckedContinuation { enteredScorecard = $0 } }
    }
    func releaseScorecard() {
        pausedScorecard?.resume()
        pausedScorecard = nil
    }
    func waitForPause() async { if paused == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        paused?.resume()
        paused = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let query = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let symbol = query.first { $0.name == "symbol" }?.value ?? "AAPL"
        var source = "cache"
        let data: TaxValue
        switch request.url.path {
        case "/api/research/chart":
            chartReads += 1
            let time: Decimal = query.first { $0.name == "range" }?.value == "3mo" ? 3000 : 1000
            data = .object([
                "symbol": .string(symbol),
                "points": .array([
                    .object(["time": .number(time), "close": .number(Decimal(string: "10.1234567890123456789")!)])
                ]),
            ])
        case "/api/research/scorecard":
            scorecardReads += 1
            if scorecardPause {
                scorecardPause = false
                await withCheckedContinuation {
                    pausedScorecard = $0
                    enteredScorecard?.resume()
                    enteredScorecard = nil
                }
            }
            source = unavailable ? "unavailable" : "cache"
            data =
                unavailable
                ? .null
                : .object([
                    "symbol": .string(symbol),
                    "fundamentals": .object(["pe": symbol == "NODATA" ? .null : .number(symbol == "AAPL" ? 10 : 20)]),
                    "scorecard": .object([
                        "score": .null, "grade": .string("unknown"), "evaluated": .number(0), "counts": .object([:]),
                        "flags": .array([]),
                    ]),
                ])
        case "/api/research/presentation":
            let body = String(decoding: request.body ?? Data(), as: UTF8.self)
            guard let from = body.range(of: "\r\n\r\n"),
                let to = body.range(of: "\r\n--", range: from.upperBound..<body.endIndex)
            else { throw APIError.invalidRequest("Malformed synthetic multipart") }
            let submitted = try JSONDecoder().decode(
                TaxValue.self, from: Data(body[from.upperBound..<to.lowerBound].utf8))
            presentations.append(submitted)
            let symbols = (submitted["series"]?.arrayValue ?? []).compactMap { $0["symbol"]?.stringValue }
            if pause {
                pause = false
                await withCheckedContinuation {
                    paused = $0
                    entered?.resume()
                    entered = nil
                }
            }
            data = compareReply(symbols: symbols)
        default: throw APIError.invalidRequest("Unexpected synthetic Research route")
        }
        return APIResponse(
            status: 200,
            body: try APIBody.encode(
                TaxValue.object([
                    "ok": .bool(true), "data": data,
                    "meta": .object([
                        "source": .string(source), "provider": .string("synthetic"), "opaque": .string("preserved"),
                    ]),
                ])))
    }
}
