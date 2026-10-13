import Foundation
import Observation

public enum PortfolioPeriod: String, CaseIterable, Sendable {
    case oneMonth = "1m"
    case threeMonths = "3m"
    case sixMonths = "6m"
    case oneYear = "1y"
    case threeYears = "3y"
    case all
    public func applying(to route: NativeRoute) -> NativeRoute {
        self == .all ? route.removing("period") : route.setting("period", to: rawValue)
    }
}
public enum PortfolioHoldingsSort: String, CaseIterable, Sendable { case value, returnRate }
public struct PortfolioBrokerOption: Equatable, Sendable, Identifiable {
    public let id: String
    public let name: String
}
public struct PortfolioBrokerSubtotal: Equatable, Sendable {
    public let currentValue: Decimal
    public let totalInvested: Decimal
    public let gainLoss: Decimal
    public let oversold: Bool
    public let providedReturnPercent: Decimal?
    public var returnPercent: Decimal {
        providedReturnPercent ?? (totalInvested == 0 ? 0 : gainLoss / abs(totalInvested) * 100)
    }
    public init(
        currentValue: Decimal, totalInvested: Decimal, gainLoss: Decimal, oversold: Bool,
        providedReturnPercent: Decimal? = nil
    ) {
        self.currentValue = currentValue
        self.totalInvested = totalInvested
        self.gainLoss = gainLoss
        self.oversold = oversold
        self.providedReturnPercent = providedReturnPercent
    }
}

@MainActor @Observable
public final class PortfolioModel {
    public private(set) var summary: PortfolioSummaryData?
    public private(set) var archiveSummary: PortfolioSummaryData?
    public private(set) var investments: [PortfolioInvestment] = []
    public private(set) var accounts: [OpenAPI.Account] = []
    public private(set) var performance: PortfolioPerformanceData?
    public private(set) var sparkline: PortfolioPerformanceData?
    public private(set) var brokerPerformance: PortfolioBrokerPerformance?
    public private(set) var exposure: PortfolioExposureData?
    public private(set) var quotes: [PortfolioQuote] = []
    public private(set) var news: [PortfolioNewsArticle] = []
    public private(set) var errors: [String: String] = [:]
    public private(set) var isFetching = false
    public private(set) var isRefreshingPrices = false
    public private(set) var priceNoticeRevision = 0
    @ObservationIgnored public var pricesDidChange: (@MainActor () -> Void)?
    public private(set) var priceRefreshResult: PortfolioPriceRefresh?
    public private(set) var priceError: String?
    public private(set) var isQuotesLoading = false
    public private(set) var isNewsLoading = false
    public private(set) var isExposureLoading = false
    public private(set) var currency = "EUR"
    public var period: PortfolioPeriod = .all
    public var showFxNeutral = false
    public var brokerFilter = "all"
    public var sort: PortfolioHoldingsSort = .value
    public var tableQuery = LocalTableQuery()
    public var isOnline = true
    public let widgets: PortfolioWidgetsModel
    public private(set) var selectedInvestmentId: Int?
    public private(set) var transactions: [PortfolioTransaction] = []
    public private(set) var historyInvestmentId: Int?
    public private(set) var historyLoading = false
    public private(set) var historyComplete = false
    public private(set) var historyVersion = 0
    public private(set) var historyError: String?
    public var error: String? { errors["investments"] ?? errors["summary"] }
    public var isLoading: Bool { summary == nil && error == nil }
    public var active: [PortfolioHolding] { summary?.summaries.filter(\.isActive) ?? [] }
    public var priceFreshness: PortfolioPriceFreshness { .aggregate(active) }
    public var stalePriceCount: Int { active.filter { PortfolioPriceFreshness.isStale($0, now: now()) }.count }
    public var archived: [PortfolioHolding] { archiveSummary?.archivedPresentation?.filter { !$0.isActive } ?? [] }
    public var selectedInvestment: PortfolioHolding? { (active + archived).first { $0.id == selectedInvestmentId } }
    public var firstInvestmentDate: String? { summary?.firstInvestmentDate }
    public func investment(id: Int) -> PortfolioInvestment? {
        guard error == nil else { return nil }
        return investments.first { $0.id == id }
    }
    public var quoteSymbols: [String] {
        Array(
            Set(
                investments.filter { $0.isActive && $0.priceProvider == "yahoo" && $0.showInTicker != false }.compactMap
                {
                    let identity = $0.priceProviderId.flatMap { $0.isEmpty ? nil : $0 } ?? $0.symbol ?? ""
                    let symbol = identity.trimmingCharacters(in: .whitespacesAndNewlines)
                        .uppercased()
                    return symbol.isEmpty ? nil : symbol
                })
        ).sorted()
    }
    public var newsSymbols: [String] { Array(active.compactMap(\.symbol).filter { !$0.isEmpty }.prefix(10)) }
    @ObservationIgnored private let service: any PortfolioService
    @ObservationIgnored private let now: @Sendable () -> Date
    @ObservationIgnored private var loadedAt: [String: Date] = [:]
    @ObservationIgnored private var performanceCache: [String: PortfolioPerformanceData] = [:]
    @ObservationIgnored private var historyCache: [Int: (Date, [PortfolioTransaction])] = [:]
    @ObservationIgnored private var context: String?
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var quoteContext: String?
    @ObservationIgnored private var newsContext: String?
    @ObservationIgnored private var quoteRevision = UUID()
    @ObservationIgnored private var newsRevision = UUID()
    @ObservationIgnored private var quoteCache: [String: [PortfolioQuote]] = [:]
    @ObservationIgnored private var newsCache: [String: [PortfolioNewsArticle]] = [:]
    @ObservationIgnored private var historyRevision = UUID()
    @ObservationIgnored private var historyTask: Task<Bool, Never>?

    public init(service: any PortfolioService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.now = now
        widgets = PortfolioWidgetsModel(service: service)
        widgets.didSave = { [weak self] in
            Task { [weak self] in
                guard let self else { return }
                async let quotes: Void = refreshQuotes()
                async let news: Void = loadNews()
                async let exposure: Void = loadExposure()
                _ = await (quotes, news, exposure)
            }
        }
    }
    public var brokerOptions: [PortfolioBrokerOption] {
        let ids = Set(active.flatMap { $0.byAccount.compactMap(\.accountId) })
        var result = ids.map { id in
            PortfolioBrokerOption(
                id: String(id), name: accounts.first { $0.id == id }.map { $0.displayName ?? $0.name } ?? "#\(id)")
        }.sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        if active.contains(where: { $0.byAccount.contains { $0.accountId == nil } }) {
            result.append(PortfolioBrokerOption(id: "unassigned", name: ""))
        }
        return result
    }
    public func metrics(for holding: PortfolioHolding) -> PortfolioBrokerSubtotal {
        if brokerFilter == "all" {
            return .init(
                currentValue: holding.currentValue, totalInvested: holding.totalInvested, gainLoss: holding.gainLoss,
                oversold: holding.oversold, providedReturnPercent: holding.gainLossPercent)
        }
        let account = brokerFilter == "unassigned" ? nil : Int(brokerFilter)
        let rows = holding.byAccount.filter { $0.accountId == account }
        return .init(
            currentValue: rows.reduce(0) { $0 + $1.currentValue },
            totalInvested: rows.reduce(0) { $0 + $1.totalInvested },
            gainLoss: rows.reduce(0) { $0 + $1.gainLoss }, oversold: rows.contains(where: \.oversold))
    }
    public var filteredHoldings: [PortfolioHolding] { holdings(assetClass: nil) }
    public var brokerSubtotal: PortfolioBrokerSubtotal {
        let rows = filteredHoldings.map { metrics(for: $0) }
        return .init(
            currentValue: rows.reduce(0) { $0 + $1.currentValue },
            totalInvested: rows.reduce(0) { $0 + $1.totalInvested },
            gainLoss: rows.reduce(0) { $0 + $1.gainLoss }, oversold: rows.contains(where: \.oversold))
    }
    public func holdings(assetClass: String?) -> [PortfolioHolding] {
        var rows = active.filter { holding in
            guard
                assetClass == nil || holding.assetClass == assetClass
                    || assetClass == "stocks" && ["stock", "etf"].contains(holding.assetClass)
                    || assetClass == "savings" && ["savings", "bond"].contains(holding.assetClass)
            else { return false }
            if brokerFilter == "all" { return true }
            guard brokerFilter == "unassigned" || Int(brokerFilter) != nil else { return false }
            return holding.byAccount.contains {
                $0.accountId == (brokerFilter == "unassigned" ? nil : Int(brokerFilter))
            }
        }
        rows.sort { a, b in
            let first = metrics(for: a)
            let second = metrics(for: b)
            let left = sort == .value ? first.currentValue : first.returnPercent
            let right = sort == .value ? second.currentValue : second.returnPercent
            return left == right ? a.id < b.id : left > right
        }
        return tableQuery.apply(
            rows,
            keys: [
                "name", "symbol", "assetClass", "currency", "totalUnits", "currentPrice", "currentValue", "gainLoss",
                "gainLossPercent",
            ]
        ) { $0.rawValue($1) }
    }
    public func invalidate() {
        revision = UUID()
        task?.cancel()
        task = nil
        loadedAt = [:]
        performanceCache = [:]
        historyRevision = UUID()
        historyTask?.cancel()
        historyTask = nil
        historyCache = [:]
        historyVersion += 1
        quoteRevision = UUID()
        newsRevision = UUID()
        quoteContext = nil
        newsContext = nil
        quoteCache = [:]
        newsCache = [:]
        historyComplete = false
        historyLoading = false
        widgets.invalidate()
        isFetching = false
        isQuotesLoading = false
        isNewsLoading = false
        isExposureLoading = false
    }
    public func load(currency: String, route: NativeRoute, force: Bool = false) async {
        showFxNeutral = route.value("fx_neutral") == "true"
        await load(
            currency: currency, period: PortfolioPeriod(rawValue: route.value("period") ?? "") ?? .all, force: force)
    }
    public func load(currency: String, force: Bool = false) async {
        await load(currency: currency, period: period, force: force)
    }
    public func load(currency: String, period: PortfolioPeriod, force: Bool = false) async {
        let key = currency + "|" + period.rawValue
        if currency != self.currency {
            invalidate()
            summary = nil
            archiveSummary = nil
            performance = nil
            sparkline = nil
            brokerPerformance = nil
            exposure = nil
            errors = [:]
        }
        if key != context {
            revision = UUID()
            task?.cancel()
            task = nil
            performance = performanceCache[key]
            context = key
        }
        self.currency = currency
        self.period = period
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        isFetching = true
        let request = Task { [weak self] in
            guard let self else { return }
            await self.fetch(token: token, force: force)
        }
        task = request
        await request.value
        guard token == revision else { return }
        task = nil
        isFetching = false
    }
    private func needs(_ key: String, ttl: TimeInterval, force: Bool) -> Bool {
        force || loadedAt[key].map { now().timeIntervalSince($0) >= ttl } ?? true
    }
    private func fetch(token: UUID, force: Bool) async {
        let service = service
        let currency = currency
        let period = period
        let performanceKey = currency + "|" + period.rawValue
        let sparkKey = currency + "|1m"
        let loadSummary = needs("summary", ttl: 30, force: force)
        async let summaryResult =
            loadSummary
            ? await Self.result { try await service.portfolioSummary(currency: currency, includeArchived: false) } : nil
        let loadArchive = needs("archive", ttl: 120, force: force)
        async let archiveResult =
            loadArchive
            ? await Self.result { try await service.portfolioSummary(currency: currency, includeArchived: true) } : nil
        let loadInvestments = needs("investments", ttl: 120, force: force)
        async let investmentsResult =
            loadInvestments ? await Self.result { try await Self.allInvestments(service: service) } : nil
        let loadAccounts = needs("accounts", ttl: 120, force: force)
        async let accountsResult = loadAccounts ? await Self.result { try await service.portfolioAccounts() } : nil
        let loadPerformance = needs(performanceKey, ttl: 300, force: force)
        async let performanceResult =
            loadPerformance
            ? await Self.result { try await service.portfolioPerformance(currency: currency, period: period) } : nil
        let loadSpark = period != .oneMonth && needs(sparkKey, ttl: 300, force: force)
        async let sparkResult =
            loadSpark
            ? await Self.result { try await service.portfolioPerformance(currency: currency, period: .oneMonth) } : nil
        let loadBroker = needs("brokers", ttl: 300, force: force)
        async let brokerResult =
            loadBroker ? await Self.result { try await service.portfolioBrokerPerformance(currency: currency) } : nil
        async let widgetLoad: Void = widgets.load()
        let answers = await (
            summaryResult, archiveResult, investmentsResult, accountsResult, performanceResult, sparkResult,
            brokerResult, widgetLoad
        )
        guard token == revision, !Task.isCancelled else { return }
        assign(answers.0, key: "summary") { value in
            try validate(value.currency, expected: currency)
            guard
                value.summaries.allSatisfy({
                    $0.isActive && $0.currency == currency && $0.assetGain != nil && $0.fxGain != nil
                        && $0.nativeCurrentValue != nil && $0.usedFallbackRate != nil
                })
            else { throw invalid("Invalid active portfolio summary") }
            summary = value
        }
        assign(answers.1, key: "archive") { value in
            try validate(value.currency, expected: currency)
            guard let rows = value.archivedPresentation, rows.allSatisfy({ !$0.isActive && $0.currency == currency })
            else { throw invalid("Missing archived presentation contract") }
            archiveSummary = value
        }
        assign(answers.2, key: "investments") { investments = $0 }
        assign(answers.3, key: "accounts") { accounts = $0 }
        assign(answers.4, key: performanceKey) { value in
            try validate(value.currency, expected: currency)
            performance = value
            performanceCache[performanceKey] = value
            if period == .oneMonth {
                sparkline = value
                performanceCache[sparkKey] = value
            }
        }
        assign(answers.5, key: sparkKey) { value in
            try validate(value.currency, expected: currency)
            sparkline = value
            performanceCache[sparkKey] = value
        }
        if sparkline == nil { sparkline = performanceCache[sparkKey] }
        assign(answers.6, key: "brokers") { value in
            try validate(value.currency, expected: currency)
            guard value.rows.allSatisfy({ $0.currency == currency }) else { throw invalid("Wrong broker row currency") }
            brokerPerformance = value
        }
        async let quotes: Void = refreshQuotes(force: force)
        async let news: Void = loadNews(force: force)
        async let exposure: Void = loadExposure(force: force)
        _ = await (quotes, news, exposure)
    }
    private nonisolated static func result<T: Sendable>(_ body: @Sendable () async throws -> T) async -> Result<
        T, APIError
    > {
        do { return .success(try await body()) } catch let error as APIError { return .failure(error) } catch {
            return .failure(.network(error.localizedDescription))
        }
    }
    private func assign<T>(_ value: Result<T, APIError>?, key: String, body: (T) throws -> Void) {
        guard let value else { return }
        do {
            try body(value.get())
            loadedAt[key] = now()
            errors.removeValue(forKey: key)
        } catch { errors[key] = error.localizedDescription }
    }
    private func validate(_ currency: String, expected: String) throws {
        if currency != expected { throw invalid("Wrong portfolio reporting currency") }
    }
    private func invalid(_ message: String) -> APIError {
        .contract(.init(endpoint: "/api/info/portfolio-summary", issues: [message]))
    }
    public func refreshQuotes(force: Bool = false) async {
        guard isOnline, widgets.isVisible("ticker") else { return }
        let symbols = quoteSymbols
        let key = "quotes|" + symbols.joined(separator: ",")
        if quoteContext != key {
            quoteRevision = UUID()
            quoteContext = key
            isQuotesLoading = false
            quotes = quoteCache[key] ?? []
            errors = errors.filter { !$0.key.hasPrefix("quotes|") }
        }
        guard !isQuotesLoading, needs(key, ttl: 60, force: force) else { return }
        let token = quoteRevision
        let version = historyVersion
        isQuotesLoading = true
        defer { if token == quoteRevision { isQuotesLoading = false } }
        let answer = await Self.result { try await self.service.portfolioQuotes(symbols: symbols) }
        guard token == quoteRevision, version == historyVersion, symbols == quoteSymbols, !Task.isCancelled else {
            return
        }
        assign(answer, key: key) {
            quotes = $0
            quoteCache[key] = $0
        }
    }
    public func loadNews(force: Bool = false) async {
        guard isOnline, widgets.isVisible("news"), !newsSymbols.isEmpty else { return }
        let symbols = newsSymbols
        let key = "news|" + symbols.joined(separator: ",")
        if newsContext != key {
            newsRevision = UUID()
            newsContext = key
            isNewsLoading = false
            news = newsCache[key] ?? []
            errors = errors.filter { !$0.key.hasPrefix("news|") }
        }
        guard !isNewsLoading, needs(key, ttl: 300, force: force) else { return }
        let token = newsRevision
        let version = historyVersion
        isNewsLoading = true
        defer { if token == newsRevision { isNewsLoading = false } }
        let answer = await Self.result { try await self.service.portfolioNews(symbols: symbols) }
        guard token == newsRevision, version == historyVersion, symbols == newsSymbols, !Task.isCancelled else {
            return
        }
        assign(answer, key: key) {
            news = $0
            newsCache[key] = $0
        }
    }
    public func loadExposure(force: Bool = false) async {
        guard widgets.isVisible("exposure"), !isExposureLoading, needs("exposure", ttl: 30, force: force) else {
            return
        }
        let version = historyVersion
        let currency = currency
        isExposureLoading = true
        defer { if version == historyVersion { isExposureLoading = false } }
        let answer = await Self.result { try await self.service.portfolioExposure(currency: currency) }
        guard version == historyVersion, currency == self.currency, !Task.isCancelled else { return }
        assign(answer, key: "exposure") {
            try validate($0.currency, expected: currency)
            exposure = $0
        }
    }
    public func refreshPrices() async {
        guard !isRefreshingPrices, isOnline else { return }
        isRefreshingPrices = true
        priceError = nil
        priceRefreshResult = nil
        defer {
            isRefreshingPrices = false
            priceNoticeRevision += 1
            pricesDidChange?()
        }
        do { priceRefreshResult = try await service.portfolioRefreshPrices() } catch {
            priceError = error.localizedDescription
        }
        await refreshAfterWrite()
    }
    public func refreshAfterWrite() async {
        let selected = selectedInvestmentId
        invalidate()
        await load(currency: currency, period: period, force: true)
        if let selected { _ = await loadHistory(investmentId: selected) }
    }
    public func openDetail(id: Int) async {
        selectedInvestmentId = id
        _ = await loadHistory(investmentId: id)
    }
    public func closeDetail() { selectedInvestmentId = nil }
    public func independentHistory(investmentId: Int) async throws -> [PortfolioTransaction] {
        if let (date, rows) = historyCache[investmentId], now().timeIntervalSince(date) < 120 { return rows }
        let version = historyVersion
        let rows = try await Self.completeHistory(service: service, investmentId: investmentId)
        guard version == historyVersion, !Task.isCancelled else { throw CancellationError() }
        historyCache[investmentId] = (now(), rows)
        return rows
    }
    @discardableResult public func loadHistory(investmentId: Int) async -> Bool {
        if historyInvestmentId == investmentId, let historyTask { return await historyTask.value }
        historyTask?.cancel()
        historyTask = nil
        let token = UUID()
        historyRevision = token
        historyInvestmentId = investmentId
        historyComplete = false
        historyError = nil
        if let (date, rows) = historyCache[investmentId], now().timeIntervalSince(date) < 120 {
            transactions = rows
            historyComplete = true
            historyLoading = false
            return true
        }
        transactions = []
        historyLoading = true
        let task = Task { [weak self] () -> Bool in
            guard let self else { return false }
            do {
                let rows = try await Self.completeHistory(service: service, investmentId: investmentId)
                guard token == historyRevision, !Task.isCancelled else { return false }
                transactions = rows
                historyCache[investmentId] = (now(), rows)
                historyComplete = true
                return true
            } catch {
                guard token == historyRevision, !Task.isCancelled else { return false }
                historyError = error.localizedDescription
                return false
            }
        }
        historyTask = task
        let complete = await task.value
        if token == historyRevision {
            historyTask = nil
            historyLoading = false
        }
        return complete
    }
    public nonisolated static func completeHistory(service: any PortfolioService, investmentId: Int) async throws
        -> [PortfolioTransaction]
    {
        var items: [PortfolioTransaction] = []
        var total: Int?
        var seen: Set<Int> = []
        repeat {
            try Task.checkCancellation()
            let page = try await service.portfolioTransactions(id: investmentId, limit: 1000, offset: items.count)
            guard page.total >= 0, total == nil || total == page.total,
                page.offset == nil || page.offset == items.count,
                !page.items.isEmpty || items.count == page.total,
                page.items.allSatisfy({ $0.investmentId == investmentId && seen.insert($0.id).inserted }),
                items.count + page.items.count <= page.total
            else {
                throw APIError.contract(
                    .init(
                        endpoint: "/api/investments/\(investmentId)/transactions",
                        issues: ["Incomplete or changing transaction history"]))
            }
            total = page.total
            items += page.items
        } while items.count < (total ?? 0)
        return items
    }
    private nonisolated static func allInvestments(service: any PortfolioService) async throws -> [PortfolioInvestment]
    {
        var items: [PortfolioInvestment] = []
        var total: Int?
        var seen: Set<Int> = []
        repeat {
            try Task.checkCancellation()
            let page = try await service.portfolioInvestments(limit: 500, offset: items.count)
            guard page.total >= 0, total == nil || total == page.total,
                page.offset == nil || page.offset == items.count,
                !page.items.isEmpty || items.count == page.total,
                page.items.allSatisfy({ seen.insert($0.id).inserted }), items.count + page.items.count <= page.total
            else {
                throw APIError.contract(
                    .init(endpoint: "/api/investments", issues: ["Incomplete or changing investment list"]))
            }
            total = page.total
            items += page.items
        } while items.count < (total ?? 0)
        return items
    }
}
