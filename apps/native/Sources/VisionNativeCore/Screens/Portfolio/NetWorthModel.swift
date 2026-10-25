import Foundation
import Observation

@MainActor @Observable
public final class NetWorthModel {
    public private(set) var data: OpenAPI.NetWorthResponse?
    public private(set) var accountRows: [NetWorthAccountRow]?
    /// The server's sum of the row totals, shown as the displayed total of the breakdown.
    public private(set) var accountsTotal: Decimal?
    public private(set) var tableSnapshots: [OpenAPI.NetWorthSnapshot] = []
    public private(set) var tableTotal = 0
    public private(set) var error: String?
    public private(set) var accountsError: String?
    public private(set) var tableError: String?
    public private(set) var pricesError: String?
    public private(set) var isFetching = false
    public private(set) var isFetchingMore = false
    public private(set) var isRefreshingPrices = false
    public private(set) var notice: ScreenNotice?
    public private(set) var priceRefreshResult: PortfolioPriceRefresh?
    @ObservationIgnored private var notices = NoticeCounter()
    @ObservationIgnored public var pricesDidChange: (@MainActor () -> Void)?
    @ObservationIgnored public var didPriceRefresh: (@MainActor (PortfolioPriceRefreshReceipt) -> Void)?
    public private(set) var currency = PortfolioCurrency.eur
    public var isOnline = true
    public var period: NetWorthPeriod = .year
    public var tableQuery = LocalTableQuery()
    public var selection: String?
    public var rangeStart: String?
    public var isLoading: Bool { isFetching && data == nil }
    public var hasMore: Bool { tableOffset < tableTotal }
    public var tableKeys: [String] {
        ["date", "liquid"]
            + (tableSnapshots.contains { abs($0.liabilities) > Decimal(string: "0.005")! } ? ["liabilities"] : [])
            + ["investments", "netWorth", "change"]
    }
    public var allTableRows: [NetWorthTableRow] {
        tableSnapshots.enumerated().map { index, snapshot in
            NetWorthTableRow(
                snapshot: snapshot,
                change: tableSnapshots.indices.contains(index + 1)
                    ? snapshot.netWorth - tableSnapshots[index + 1].netWorth : nil)
        }
    }
    public var tableRows: [NetWorthTableRow] { tableQuery.apply(allTableRows, keys: tableKeys) { $0.rawValue($1) } }
    public func tableFilterValues(_ key: String) -> [String] {
        LocalTableQuery.uniqueValues(allTableRows, key: key) { $0.rawValue($1) }
    }
    public private(set) var snapshots: [OpenAPI.NetWorthSnapshot] = []
    public var displaySnapshots: [OpenAPI.NetWorthSnapshot] { period.filter(snapshots) }
    public var peak: Decimal? {
        data.map { max($0.current.netWorth, displaySnapshots.map(\.netWorth).max() ?? $0.current.netWorth) }
    }
    public var trough: Decimal? {
        data.map { min($0.current.netWorth, displaySnapshots.map(\.netWorth).min() ?? $0.current.netWorth) }
    }
    public var allTimeChange: Decimal? { data.map { $0.current.netWorth - (snapshots.first?.netWorth ?? 0) } }
    public var allTimePercent: Decimal? {
        guard let first = snapshots.first?.netWorth, let change = allTimeChange else { return nil }
        return first == 0 ? 0 : change / abs(first) * 100
    }
    public var assets: Decimal? { data.map { $0.current.liquid + $0.current.investments } }
    public var debt: Decimal? { data.map { abs($0.current.liabilities) } }
    public var stalePriceCount: Int {
        prices.filter { row in
            guard row.isLive else { return false }
            guard let raw = row.priceUpdatedAt, let date = VisionFormat.parseTimestamp(raw) else { return true }
            return clock().timeIntervalSince(date) > 86_400
        }.count
    }
    /// nil means no live providers; an empty string means one has never returned a usable timestamp.
    public var priceFreshness: String? {
        let live = prices.filter(\.isLive)
        guard !live.isEmpty else { return nil }
        let dated = live.compactMap { row -> (String, Date)? in
            guard let raw = row.priceUpdatedAt, let date = VisionFormat.parseTimestamp(raw) else { return nil }
            return (raw, date)
        }
        guard dated.count == live.count else { return "" }
        return dated.min { $0.1 < $1.1 }?.0
    }
    @ObservationIgnored private let service: any NetWorthService
    @ObservationIgnored private let clock: @Sendable () -> Date
    private var prices: [NetWorthInvestmentPrice] = []
    @ObservationIgnored private var context: String?
    @ObservationIgnored private var pageSize = 50
    @ObservationIgnored private var tableOffset = 0
    @ObservationIgnored private var revision = UUID()
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var fetchedAt: Date?
    @ObservationIgnored private var latestRoute: NativeRoute?

    public init(service: any NetWorthService, now: @escaping @Sendable () -> Date = { Date() }) {
        self.service = service
        self.clock = now
    }
    public func invalidate() {
        revision = UUID()
        task?.cancel()
        task = nil
        fetchedAt = nil
        isFetching = false
        isFetchingMore = false
    }
    public func load(currency: CurrencyCode, pageSize: Int, route: NativeRoute, force: Bool = false) async {
        latestRoute = route
        let nextPeriod = NetWorthPeriod(route: route)
        if period != nextPeriod {
            selection = nil
            rangeStart = nil
        }
        period = nextPeriod
        let key = "\(currency.rawValue)|\(pageSize)"
        if context != key {
            invalidate()
            context = key
            self.currency = currency
            self.pageSize = max(1, min(10_000, pageSize))
            data = nil
            snapshots = []
            accountRows = nil
            accountsTotal = nil
            prices = []
            tableSnapshots = []
            tableTotal = 0
            tableOffset = 0
            error = nil
            accountsError = nil
            tableError = nil
            pricesError = nil
            selection = nil
            rangeStart = nil
            tableQuery = LocalTableQuery()
        }
        if !force, let fetchedAt, clock().timeIntervalSince(fetchedAt) < 120 { return }
        if let task {
            await task.value
            return
        }
        let token = UUID()
        revision = token
        isFetchingMore = false
        isFetching = true
        let task = Task { [weak self] in
            guard let self else { return }
            async let history: Void = fetchSummary(token: token)
            async let accounts: Void = fetchAccounts(token: token)
            async let table: Void = fetchTable(token: token, initial: true)
            async let prices: Void = fetchPrices(token: token)
            _ = await (history, accounts, table, prices)
        }
        self.task = task
        await task.value
        guard token == revision else { return }
        self.task = nil
        isFetching = false
        if error == nil { fetchedAt = clock() }
    }
    public func loadMore() async {
        guard hasMore, !isFetchingMore, !isFetching else { return }
        let token = revision
        isFetchingMore = true
        await fetchTable(token: token, initial: false)
        if token == revision { isFetchingMore = false }
    }
    public func refreshPrices(route: NativeRoute) async {
        guard isOnline, !isRefreshingPrices else { return }
        isRefreshingPrices = true
        defer {
            isRefreshingPrices = false
            pricesDidChange?()
        }
        var refreshFailure: String?
        do {
            let result = try await service.refreshNetWorthPrices()
            priceRefreshResult = result
            if let didPriceRefresh {
                didPriceRefresh(PortfolioPriceRefreshReceipt(result: result, error: nil, offline: !isOnline))
            } else {
                notice = notices.make(
                    result.staleCount > 0 ? .info : .success, "portfolio.refreshedPrices",
                    ["n": String(result.total ?? 0)])
            }
        } catch {
            pricesError = error.localizedDescription
            refreshFailure = error.localizedDescription
            if let didPriceRefresh {
                didPriceRefresh(
                    PortfolioPriceRefreshReceipt(result: nil, error: error.localizedDescription, offline: !isOnline))
            } else {
                notice = notices.make(.error, "portfolio.refreshPricesFailedTitle", detail: error.localizedDescription)
            }
        }
        // A missing acknowledgement can follow successful provider writes. Read the
        // authoritative financial state on either outcome, retaining the refresh error.
        invalidate()
        let currentRoute = latestRoute ?? route
        let refreshedRoute =
            period == .year ? currentRoute.removing("period") : currentRoute.setting("period", to: period.rawValue)
        await load(currency: currency, pageSize: pageSize, route: refreshedRoute, force: true)
        if let refreshFailure { pricesError = refreshFailure }
    }
    public func attachNotices(_ center: NativeNoticeCenter) {
        notices.attach(center) { [weak self] in self?.clearNotice($0) }
    }

    public func clearNotice(_ id: Int) { if notice?.id == id { notice = nil } }
    private func fetchSummary(token: UUID) async {
        do {
            let value = try await service.netWorth(currency: currency, limit: nil, offset: nil)
            guard token == revision, !Task.isCancelled else { return }
            guard value.current.currency == currency else { throw APIError.invalidRequest("Wrong net worth currency") }
            data = value
            snapshots = value.snapshots
            error = nil
        } catch { if token == revision, !Task.isCancelled { self.error = error.localizedDescription } }
    }
    private func fetchAccounts(token: UUID) async {
        do {
            let response = try await service.netWorthByAccount(currency: currency)
            guard token == revision, !Task.isCancelled else { return }
            guard response.currency == currency else {
                throw APIError.invalidRequest("Wrong net worth breakdown currency")
            }
            // A cash balance without a stored rate leaves the breakdown unavailable (ADR-216).
            guard let breakdown = NetWorthAccountRow.rows(from: response) else {
                throw APIError.invalidRequest("Unavailable exchange rate for net worth breakdown")
            }
            accountRows = breakdown.rows
            accountsTotal = breakdown.total
            accountsError = nil
        } catch {
            if token == revision, !Task.isCancelled {
                accountRows = nil
                accountsTotal = nil
                accountsError = error.localizedDescription
            }
        }
    }
    private func fetchPrices(token: UUID) async {
        do {
            let rows = try await service.netWorthPrices()
            guard token == revision, !Task.isCancelled else { return }
            prices = rows
            pricesError = nil
        } catch {
            if token == revision, !Task.isCancelled {
                prices = []
                pricesError = error.localizedDescription
            }
        }
    }
    private func fetchTable(token: UUID, initial: Bool) async {
        let offset = initial ? 0 : tableOffset
        do {
            let value = try await service.netWorth(currency: currency, limit: pageSize, offset: offset)
            guard token == revision, !Task.isCancelled else { return }
            guard value.current.currency == currency, let total = value.snapshotsTotal,
                total >= offset + value.snapshots.count,
                value.snapshotsOffset == offset, let limit = value.snapshotsLimit, limit > 0,
                !value.snapshots.isEmpty || offset >= total
            else { throw APIError.invalidRequest("Incomplete net worth snapshot page") }
            let rows = value.snapshots
            if initial { tableSnapshots = [] }
            var known = Set(tableSnapshots.map(\.date))
            tableSnapshots += rows.filter { known.insert($0.date).inserted }
            tableOffset = offset + value.snapshots.count
            tableTotal = total
            tableError = nil
        } catch { if token == revision, !Task.isCancelled { tableError = error.localizedDescription } }
    }
}
