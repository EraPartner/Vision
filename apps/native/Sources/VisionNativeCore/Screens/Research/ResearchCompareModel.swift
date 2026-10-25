import Foundation
import Observation

public struct ResearchComparePresentation: Equatable, Sendable {
    public struct Row: Equatable, Sendable, Identifiable {
        public let time: Decimal
        public let values: [String: Decimal]
        public var id: Decimal { time }
    }
    public struct Stats: Equatable, Sendable, Identifiable {
        public let symbol: String
        public let totalReturn: Decimal?
        public let volatility: Decimal?
        public let maxDrawdown: Decimal?
        public let firstTime: Decimal?
        public let lastTime: Decimal?
        public var id: String { symbol }
    }
    public let raw: TaxValue
    public let rows: [Row]
    public let stats: [Stats]
    public let symbols: [String]
    public let correlation: [[Decimal?]]
    public init(raw: TaxValue, symbols: [String]) throws {
        guard raw["kind"] == .string("compare"), let result = raw["result"]?.objectValue,
            let rows = result["rows"]?.arrayValue, let stats = result["stats"]?.arrayValue,
            let matrix = result["correlation"]?["matrix"]?.arrayValue,
            result["correlation"]?["symbols"] == .array(symbols.map(TaxValue.string)),
            stats.map({ $0["symbol"]?.stringValue }) == symbols.map(Optional.some), matrix.count == symbols.count
        else { throw Self.invalid() }
        self.raw = raw
        self.symbols = symbols
        self.rows = try rows.map { row in
            guard let time = row["time"]?.decimalValue, !time.isNaN else { throw Self.invalid() }
            var values: [String: Decimal] = [:]
            for symbol in symbols {
                if let value = try Self.optionalNumber(row[symbol]) { values[symbol] = value }
            }
            return Row(time: time, values: values)
        }
        self.stats = try stats.map { row in
            Stats(
                symbol: row["symbol"]?.stringValue ?? "", totalReturn: try Self.optionalNumber(row["totalReturn"]),
                volatility: try Self.optionalNumber(row["volatility"]),
                maxDrawdown: try Self.optionalNumber(row["maxDrawdown"]),
                firstTime: try Self.optionalNumber(row["firstTime"]), lastTime: try Self.optionalNumber(row["lastTime"])
            )
        }
        correlation = try matrix.map { row in
            guard let values = row.arrayValue, values.count == symbols.count else { throw Self.invalid() }
            return try values.map(Self.optionalNumber)
        }
    }
    private static func optionalNumber(_ value: TaxValue?) throws -> Decimal? {
        guard let value, value != .null else { return nil }
        guard let number = value.decimalValue, !number.isNaN else { throw invalid() }
        return number
    }
    private static func invalid() -> APIError {
        .contract(.init(endpoint: "research-presentation", issues: ["Invalid submitted-data Compare result"]))
    }
}

@MainActor @Observable
public final class ResearchCompareModel {
    public let search: ResearchSearchModel
    public private(set) var route = NativeRoute(.compare)
    public var state: ResearchCompareURLState { .init(route: route) }
    public private(set) var charts: [String: ResearchSnapshot<ResearchChartData>] = [:]
    public private(set) var fundamentals: [String: ResearchSnapshot<ResearchScorecardData?>] = [:]
    public private(set) var chartFetching: Set<String> = []
    public private(set) var fundamentalsFetching: Set<String> = []
    public private(set) var chartErrors: [String: String] = [:]
    public private(set) var fundamentalsErrors: [String: String] = [:]
    public private(set) var presentation: ResearchComparePresentation?
    public private(set) var presentationError: String?
    public private(set) var isPreparing = false
    public var isOnline = true {
        didSet {
            search.isOnline = isOnline
            if !isOnline { cancelReads() }
        }
    }
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var loadedKey: String?
    @ObservationIgnored private var readTask: Task<Void, Never>?

    public init(service: any ResearchService, cache: ResearchReadCache? = nil) {
        self.service = service
        let cache = cache ?? ResearchReadCache()
        self.cache = cache
        search = ResearchSearchModel(service: service, source: .research, cache: cache)
    }
    public var isLoading: Bool { state.symbols.contains { chartFetching.contains($0) && charts[$0] == nil } }
    public var fundamentalsLoading: Bool {
        state.symbols.contains { fundamentalsFetching.contains($0) && fundamentals[$0] == nil }
    }
    public var sortedFundamentalsSymbols: [String] {
        guard let key = state.sort, let metric = ResearchCompareMetric.all.first(where: { $0.id == key }) else {
            return state.symbols
        }
        return state.symbols.enumerated().sorted { a, b in
            let left = fundamentals[a.element]?.data?.fundamentals[key]?.decimalValue
            let right = fundamentals[b.element]?.data?.fundamentals[key]?.decimalValue
            switch (left, right) {
            case (nil, nil): return a.offset < b.offset
            case (nil, _): return false
            case (_, nil): return true
            case (.some(let l), .some(let r)):
                return l == r ? a.offset < b.offset : metric.higherIsBetter ? l > r : l < r
            }
        }.map(\.element)
    }
    public func addSymbol(_ raw: String) -> NativeRoute {
        let next = state.adding(raw, to: route)
        search.clear()
        acceptRoute(next)
        return next
    }
    public func removeSymbol(_ symbol: String) -> NativeRoute {
        let next = state.removing(symbol, from: route)
        acceptRoute(next)
        return next
    }
    public func selectRange(_ range: String) -> NativeRoute {
        let next = state.settingRange(range, in: route)
        acceptRoute(next)
        return next
    }
    public func selectTab(_ tab: String) -> NativeRoute {
        let next = state.settingTab(tab, in: route)
        acceptRoute(next)
        return next
    }
    public func toggleSort(_ key: String) -> NativeRoute {
        let next = state.togglingSort(key, in: route)
        acceptRoute(next)
        return next
    }
    private func acceptRoute(_ next: NativeRoute) {
        let previous = state
        route = next
        if previous.sourceKey != state.sourceKey {
            cancelReads()
            presentation = nil
            presentationError = nil
            if previous.range != state.range {
                charts = [:]
                chartErrors = [:]
            } else {
                charts = charts.filter { state.symbols.contains($0.key) }
                chartErrors = chartErrors.filter { state.symbols.contains($0.key) }
            }
            fundamentals = fundamentals.filter { state.symbols.contains($0.key) }
            fundamentalsErrors = fundamentalsErrors.filter { state.symbols.contains($0.key) }
        }
    }
    public func load(route: NativeRoute, force: Bool = false) async {
        acceptRoute(route)
        guard isOnline, route.path == "/research/compare" else { return }
        let source = state
        guard force || loadedKey != source.sourceKey else {
            await readTask?.value
            return
        }
        cancelReads()
        loadedKey = source.sourceKey
        let current = generation
        guard !source.symbols.isEmpty else {
            presentation = nil
            return
        }
        if force {
            for symbol in source.symbols {
                cache.invalidate(key: ResearchReadKey.chart(symbol: symbol, range: source.range))
                cache.invalidate(key: ResearchReadKey.scorecard(symbol: symbol))
            }
        }
        chartFetching = Set(source.symbols)
        fundamentalsFetching = Set(source.symbols)
        let task = Task { [weak self] in
            guard let self else { return }
            await withTaskGroup(of: ReadResult.self) { group in
                var submittedPresentation = false
                for symbol in source.symbols {
                    group.addTask { [service, cache] in
                        do {
                            let snapshot = try await cache.request(
                                key: ResearchReadKey.chart(
                                    symbol: symbol, range: source.range, assetClass: nil, provider: nil), freshFor: 60,
                                force: force
                            ) {
                                try await service.researchChart(
                                    symbol: symbol, range: source.range, assetClass: nil, provider: nil)
                            }
                            return .chart(symbol, .success(snapshot))
                        } catch { return .chart(symbol, .failure(error)) }
                    }
                    group.addTask { [service, cache] in
                        do {
                            let snapshot = try await cache.request(
                                key: ResearchReadKey.scorecard(symbol: symbol, assetClass: nil), freshFor: 86_400,
                                force: force
                            ) {
                                try await service.researchScorecard(symbol: symbol, assetClass: nil)
                            }
                            return .fundamentals(symbol, .success(snapshot))
                        } catch { return .fundamentals(symbol, .failure(error)) }
                    }
                }
                for await result in group {
                    guard current == generation, state.sourceKey == source.sourceKey, !Task.isCancelled else {
                        continue
                    }
                    switch result {
                    case .chart(let symbol, let value):
                        chartFetching.remove(symbol)
                        switch value {
                        case .success(let snapshot):
                            charts[symbol] = snapshot
                            chartErrors[symbol] = nil
                        case .failure(let error):
                            if !(error is CancellationError) { chartErrors[symbol] = error.localizedDescription }
                        }
                    case .fundamentals(let symbol, let value):
                        fundamentalsFetching.remove(symbol)
                        switch value {
                        case .success(let snapshot):
                            fundamentals[symbol] = snapshot
                            fundamentalsErrors[symbol] = nil
                        case .failure(let error):
                            if !(error is CancellationError) { fundamentalsErrors[symbol] = error.localizedDescription }
                        }
                    case .presentation(let value):
                        isPreparing = false
                        switch value {
                        case .success(let output):
                            presentation = output
                            presentationError = nil
                        case .failure(let error):
                            if !(error is CancellationError) { presentationError = error.localizedDescription }
                        }
                    }
                    if chartFetching.isEmpty && !submittedPresentation {
                        submittedPresentation = true
                        isPreparing = true
                        let input = presentationInput(symbols: source.symbols)
                        group.addTask { [service] in
                            do {
                                let response = try await service.researchPresentation(input)
                                return .presentation(
                                    .success(try ResearchComparePresentation(raw: response, symbols: source.symbols)))
                            } catch { return .presentation(.failure(error)) }
                        }
                    }
                }
            }
        }
        readTask = task
        await task.value
        if current == generation { readTask = nil }
    }
    public func presentationInput(symbols: [String]? = nil) -> TaxValue {
        .object([
            "kind": .string("compare"),
            "series": .array(
                (symbols ?? state.symbols).map { symbol in
                    .object([
                        "symbol": .string(symbol),
                        "points": .array(
                            (charts[symbol]?.data.points ?? []).map { point in
                                .object([
                                    "time": .number(point.time), "close": point.close.map(TaxValue.number) ?? .null,
                                ])
                            }),
                    ])
                }),
        ])
    }
    public func didDisappear() {
        cancelReads()
        search.clear()
    }
    public func invalidate() {
        cancelReads()
        cache.invalidate(prefix: "[\"research-chart\"")
        cache.invalidate(prefix: "[\"research-scorecard\"")
    }
    private func cancelReads() {
        generation += 1
        loadedKey = nil
        readTask?.cancel()
        readTask = nil
        chartFetching = []
        fundamentalsFetching = []
        isPreparing = false
    }
    private enum ReadResult: Sendable {
        case chart(String, Result<ResearchSnapshot<ResearchChartData>, any Error>)
        case fundamentals(String, Result<ResearchSnapshot<ResearchScorecardData?>, any Error>)
        case presentation(Result<ResearchComparePresentation, any Error>)
    }
}
