import Foundation
import Observation

@MainActor @Observable
public final class ResearchWatchlistModel {
    public let add: ResearchWatchlistAddModel
    public private(set) var page: ResearchWatchlistPage?
    public private(set) var isLoading = false
    public private(set) var error: String?
    public private(set) var quotes: [String: ResearchQuote] = [:]
    public private(set) var quotesError: String?
    public private(set) var isQuotesLoading = false
    public var isOnline = true
    public var quotesUnavailable: Bool { !isOnline || quotesError != nil }
    public private(set) var metrics: [Int: ResearchWatchlistMetrics] = [:]
    public private(set) var selectedItemID: Int?
    public var selectedItem: ResearchWatchlistItem? { page?.items.first { $0.id == selectedItemID } }
    public private(set) var range: ResearchWatchlistRange = .month
    public private(set) var chart: ResearchChartData?
    public private(set) var chartQuote: ResearchQuote?
    public private(set) var chartMetrics: ResearchWatchlistChartMetrics?
    public private(set) var isChartLoading = false
    public private(set) var isChartQuoteLoading = false
    public private(set) var isEditingTarget = false
    public var targetDraft = ""
    public private(set) var isMutating = false
    public private(set) var targetValidationFailed = false
    public private(set) var validationRevision = 0
    public private(set) var actionError: String?
    public var deletingItem: ResearchWatchlistItem?
    public private(set) var notice: ScreenNotice?
    @ObservationIgnored public var didMutate: (@MainActor () async -> Void)?
    @ObservationIgnored private let service: any ResearchService
    @ObservationIgnored private let cache: ResearchReadCache
    @ObservationIgnored private var readRevision = UUID()
    @ObservationIgnored private var quotesRevision = UUID()
    @ObservationIgnored private var metricsRevision = UUID()
    @ObservationIgnored private var chartRevision = UUID()
    @ObservationIgnored private var chartQuoteRevision = UUID()
    @ObservationIgnored private var chartMetricsRevision = UUID()
    @ObservationIgnored private var dirty = true
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored private var configuredNumberFormat: NumberFormat = .eu
    @ObservationIgnored private var visitRevision = UUID()
    @ObservationIgnored private var editorRevision = UUID()
    @ObservationIgnored private var isVisible = false
    @ObservationIgnored private var quoteSymbols: [String]?

    public init(service: any ResearchService, add: ResearchWatchlistAddModel? = nil, cache: ResearchReadCache? = nil) {
        self.service = service
        self.cache = cache ?? ResearchReadCache()
        self.add = add ?? ResearchWatchlistAddModel(service: service)
    }

    public func configure(settings: NativeAppSettings) { configuredNumberFormat = settings.numberFormat }

    public func didDisappear() {
        visitRevision = UUID()
        isVisible = false
        quotesRevision = UUID()
        isQuotesLoading = false
        quoteSymbols = nil
        invalidate()
        closeChart()
        if !add.isSubmitting { add.close() }
    }

    public func invalidate() {
        cache.invalidate(key: ResearchReadKey.watchlist)
        readRevision = UUID()
        metricsRevision = UUID()
        chartMetricsRevision = UUID()
        isLoading = false
        dirty = true
    }

    public func load(force: Bool = false) async {
        isVisible = true
        guard !isLoading || force, force || dirty || page == nil else { return }
        let revision = UUID()
        readRevision = revision
        isLoading = true
        error = nil
        defer { if readRevision == revision { isLoading = false } }
        do {
            let service = service
            let result: ResearchWatchlistPage = try await cache.request(
                key: ResearchReadKey.watchlist, freshFor: 0, force: true
            ) {
                try await service.researchWatchlist()
            }
            // A newer read or leaving the page changes `readRevision`. A cancelled caller is not
            // stale: a restarted visit that arrives while this read is in flight returns early,
            // so dropping this result would leave the page blank.
            guard readRevision == revision else { return }
            let previousTarget = selectedItem?.targetPrice
            page = result
            dirty = false
            metrics = [:]
            if previousTarget != selectedItem?.targetPrice {
                chartMetrics = nil
                chartMetricsRevision = UUID()
            }
            metricsRevision = UUID()
            if selectedItemID != nil, selectedItem == nil { closeChart() }
            let symbols = Self.symbols(result)
            if quoteSymbols != symbols {
                quotesRevision = UUID()
                isQuotesLoading = false
                await loadQuotes()
            } else {
                // The web list invalidation does not invalidate the separate
                // watchlist-quotes key when its symbol string is unchanged.
                await updateMetrics()
            }
            if selectedItem != nil { await updateChartMetrics() }
        } catch {
            guard readRevision == revision else { return }
            self.error = error.localizedDescription
            dirty = true
        }
    }

    public func poll() async { if isOnline { await loadQuotes() } }

    public func loadQuotes() async {
        guard isVisible, isOnline, !isQuotesLoading else { return }
        let symbols = page.map(Self.symbols) ?? []
        quoteSymbols = symbols
        guard !symbols.isEmpty else {
            quotes = [:]
            metrics = [:]
            return
        }
        let revision = UUID()
        quotesRevision = revision
        isQuotesLoading = true
        defer { if quotesRevision == revision { isQuotesLoading = false } }
        do {
            var result: [ResearchQuote]
            let service = service
            do {
                result = try await cache.request(
                    key: ResearchReadKey.quotes(symbols: symbols), freshFor: 0, force: true
                ) {
                    try await service.marketQuotes(symbols: symbols, detail: "basic")
                }
            } catch {
                guard quotesRevision == revision, !Task.isCancelled, isOnline else { return }
                result = try await cache.request(
                    key: ResearchReadKey.quotes(symbols: symbols), freshFor: 0, force: true
                ) {
                    try await service.marketQuotes(symbols: symbols, detail: "basic")
                }
            }
            guard quotesRevision == revision, !Task.isCancelled else { return }
            quotes = Dictionary(result.map { ($0.symbol, $0) }, uniquingKeysWith: { _, latest in latest })
            quotesError = nil
            await updateMetrics()
        } catch {
            guard quotesRevision == revision, !Task.isCancelled else { return }
            quotesError = error.localizedDescription
            // A failed refetch retains the prior quotes and comparisons, as the
            // web query cache does, alongside its unavailable warning.
        }
    }

    private static func symbols(_ page: ResearchWatchlistPage) -> [String] {
        page.items.compactMap { $0.symbol.flatMap { $0.isEmpty ? nil : $0 } }
    }

    private func updateMetrics() async {
        guard let page else { return }
        let revision = UUID()
        metricsRevision = revision
        let entries: [TaxValue] = page.items.map { item in
            .object([
                "id": .number(Decimal(item.id)), "targetPrice": .number(item.targetPrice),
                "currentPrice": item.symbol.flatMap { quotes[$0]?.price }.map(TaxValue.number) ?? .null,
                "addedPrice": item.addedPrice.map(TaxValue.number) ?? .null,
            ])
        }
        do {
            let raw = try await service.researchPresentation(
                .object([
                    "kind": .string("watchlistBatch"), "entries": .array(entries),
                ]))
            struct Batch: Decodable {
                struct Entry: Decodable {
                    let id: Int
                    let list: ResearchWatchlistMetrics
                }
                let entries: [Entry]
            }
            guard let decoded = try raw["result"]?.decode(Batch.self) else { return }
            guard metricsRevision == revision, !Task.isCancelled else { return }
            metrics = Dictionary(decoded.entries.map { ($0.id, $0.list) }, uniquingKeysWith: { _, latest in latest })
        } catch { if metricsRevision == revision { metrics = [:] } }
    }

    public func openChart(id: Int) async {
        guard page?.items.contains(where: { $0.id == id }) == true else { return }
        if selectedItemID != id {
            closeChart()
            selectedItemID = id
            range = .month
        }
        async let points: Void = loadChart()
        async let quote: Void = loadChartQuote()
        _ = await (points, quote)
    }

    public func closeChart() {
        editorRevision = UUID()
        selectedItemID = nil
        chartRevision = UUID()
        chartQuoteRevision = UUID()
        chartMetricsRevision = UUID()
        chart = nil
        chartQuote = nil
        chartMetrics = nil
        isChartLoading = false
        isChartQuoteLoading = false
        range = .month
        isEditingTarget = false
        targetDraft = ""
        targetValidationFailed = false
        actionError = nil
    }

    public func selectRange(_ range: ResearchWatchlistRange) async {
        self.range = range
        chartRevision = UUID()
        isChartLoading = false
        chart = nil
        chartMetrics = nil
        await loadChart()
    }

    private func loadChart() async {
        guard !isChartLoading, let item = selectedItem, let symbol = item.symbol, !symbol.isEmpty else {
            await updateChartMetrics()
            return
        }
        let id = item.id
        let range = range
        let revision = UUID()
        chartRevision = revision
        isChartLoading = true
        defer { if chartRevision == revision { isChartLoading = false } }
        let result = try? await service.marketChart(symbol: symbol, range: range.rawValue, interval: range.interval)
        guard chartRevision == revision, selectedItemID == id, self.range == range, !Task.isCancelled else { return }
        chart = result
        await updateChartMetrics()
    }

    private func loadChartQuote() async {
        guard !isChartQuoteLoading, let item = selectedItem, let symbol = item.symbol, !symbol.isEmpty else {
            await updateChartMetrics()
            return
        }
        let id = item.id
        let revision = UUID()
        chartQuoteRevision = revision
        isChartQuoteLoading = true
        defer { if chartQuoteRevision == revision { isChartQuoteLoading = false } }
        let result = try? await service.marketQuotes(symbols: [symbol], detail: "basic")
        guard chartQuoteRevision == revision, selectedItemID == id, !Task.isCancelled else { return }
        chartQuote = result?.first
        await updateChartMetrics()
    }

    private func updateChartMetrics() async {
        guard let item = selectedItem else { return }
        let revision = UUID()
        chartMetricsRevision = revision
        do {
            let raw = try await service.researchPresentation(
                ResearchWatchlistPresentation.input(
                    target: item.targetPrice, current: chartQuote?.price, added: item.addedPrice,
                    points: chart?.points ?? []))
            guard let result = try raw["result"]?.decode(ResearchWatchlistPresentation.self) else { return }
            guard chartMetricsRevision == revision, selectedItemID == item.id, !Task.isCancelled else { return }
            chartMetrics = result.chart
        } catch { if chartMetricsRevision == revision { chartMetrics = nil } }
    }

    public func beginTargetEdit(numberFormat: NumberFormat? = nil) {
        guard !isMutating, let item = selectedItem else { return }
        targetDraft = LocaleNumber.editable(item.targetPrice, format: numberFormat ?? configuredNumberFormat)
        editorRevision = UUID()
        isEditingTarget = true
        targetValidationFailed = false
        actionError = nil
    }
    public func cancelTargetEdit() {
        guard !isMutating else { return }
        isEditingTarget = false
    }

    @discardableResult public func saveTarget(numberFormat: NumberFormat? = nil) async -> Bool {
        guard !isMutating, isEditingTarget, let item = selectedItem, !targetDraft.isEmpty else { return false }
        guard let target = ResearchWatchlistInput.price(targetDraft, format: numberFormat ?? configuredNumberFormat)
        else {
            targetValidationFailed = true
            validationRevision += 1
            return false
        }
        return await mutate(key: "watchlist.targetUpdated", failure: "watchlist.updateFailed") {
            _ = try await self.service.researchUpdateWatchlist(
                id: item.id, input: .object(["target_price": .number(target)]))
        }
    }

    @discardableResult public func deleteConfirmed() async -> Bool {
        guard !isMutating, let item = deletingItem else { return false }
        deletingItem = nil
        return await mutate(key: "watchlist.removedSuccess", failure: "common.error") {
            try await self.service.researchDeleteWatchlist(id: item.id)
        }
    }

    private func mutate(key: String, failure: String, action: () async throws -> Void) async -> Bool {
        let visit = visitRevision
        let editor = editorRevision
        isMutating = true
        actionError = nil
        invalidate()
        var success = false
        var failureMessage: String?
        do {
            try await action()
            success = true
        } catch { failureMessage = error.localizedDescription }
        if let didMutate { await didMutate() }
        // Reads started while a write was pending must not overwrite authority.
        if visitRevision == visit && isVisible {
            invalidate()
            await load(force: true)
        } else {
            // Invalidation after an unmounted query does not restart Yahoo
            // consumers. The write still requires authority read-back.
            cache.invalidate(key: ResearchReadKey.watchlist)
            _ = try? await service.researchWatchlist()
        }
        isMutating = false
        if visitRevision == visit && editorRevision == editor { actionError = failureMessage }
        if success && visitRevision == visit && editorRevision == editor {
            isEditingTarget = false
            targetDraft = ""
        }
        notice = notices.make(success ? .success : .error, success ? key : failure, detail: failureMessage)
        return success
    }

    public func refreshAfterAdd() async {
        invalidate()
        await load(force: true)
    }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
}
