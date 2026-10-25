import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Native Net Worth history and currency isolation")
struct NetWorthTests {
    @Test func dailyHistoryAndNewestFirstPagesStayIndependentAndDeduplicateDates() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth")))
        #expect(model.snapshots.map(\.date) == ["2025-06-01", "2025-06-02", "2025-06-03", "2025-06-04"])
        #expect(model.tableSnapshots.map(\.date) == ["2025-06-04", "2025-06-03"])
        #expect(model.hasMore)
        await model.loadMore()
        #expect(model.tableSnapshots.map(\.date) == ["2025-06-04", "2025-06-03", "2025-06-02"])
        #expect(!model.hasMore)
        #expect(model.allTableRows.map(\.change) == [1, 1, nil])
        let offsets = await service.calls.map { $0.offset }
        #expect(offsets == [nil, 0, 2] || offsets == [0, nil, 2])
    }
    @Test func emptyPrematurePageIsUnavailableRatherThanClaimingCompleteHistory() async throws {
        let service = NetWorthFake()
        await service.setEmptyPage()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth")))
        #expect(model.data != nil)
        #expect(model.tableError != nil)
        #expect(model.tableSnapshots.isEmpty)
        #expect(!model.hasMore)
    }
    @Test func anOlderCurrencyRequestCannotReplaceNewerHistoryOrAccountValues() async throws {
        let service = NetWorthFake()
        await service.pauseEuroHistory()
        let model = NetWorthModel(service: service)
        let route = try #require(NativeRoute("/portfolio/net-worth"))
        let old = Task { await model.load(currency: "EUR", pageSize: 2, route: route) }
        await service.waitForPause()
        await model.load(currency: "USD", pageSize: 2, route: route)
        #expect(model.currency == "USD")
        #expect(model.data?.current.currency == "USD")
        #expect(model.data?.current.netWorth == 200)
        await service.release()
        await old.value
        #expect(model.data?.current.currency == "USD")
        #expect(model.data?.current.netWorth == 200)
        #expect(!model.isFetching)
    }
    @Test func periodAnchorsToTheLastDayAndChangingItDoesNotRefetch() async throws {
        let rows = [snapshot("2025-03-31", 1), snapshot("2025-04-01", 2), snapshot("2025-05-01", 3)]
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = try #require(TimeZone(secondsFromGMT: 0))
        #expect(NetWorthPeriod.month.filter(rows, calendar: calendar).map(\.date) == ["2025-04-01", "2025-05-01"])
        #expect(NetWorthPeriod(route: try #require(NativeRoute("/portfolio/net-worth?period=invalid"))) == .year)
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth")))
        let before = await service.calls.count
        model.selection = "2025-06-01"
        model.rangeStart = "2025-06-02"
        await model.load(
            currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth?period=all")))
        #expect(model.period == .all)
        #expect(model.selection == nil && model.rangeStart == nil)
        #expect(await service.calls.count == before)
    }
    @Test func breakdownRowsAreTheServerFiguresLabelledAndOrdered() throws {
        let response = OpenAPI.NetWorthByAccountResponse(
            currency: "EUR",
            rows: [
                .init(
                    accountId: 2, name: "Wallet", type: "wallet", cashCurrency: "EUR", cash: 0, holdings: 20,
                    total: 20, unconverted: false),
                .init(
                    accountId: 1, name: "Cash", type: "bank", cashCurrency: "USD", cash: 4, holdings: 0, total: 4,
                    unconverted: false),
                .init(
                    accountId: 3, name: nil, type: nil, cashCurrency: nil, cash: nil, holdings: 1, total: nil,
                    unconverted: false),
                .init(accountId: nil, holdings: 5, total: 5, unconverted: false),
            ], total: 29, unconvertedAccountIds: [])
        let breakdown = try #require(NetWorthAccountRow.rows(from: response))
        #expect(breakdown.total == 29)
        #expect(breakdown.rows.last?.accountId == nil)
        #expect(breakdown.rows.last?.total == 5)
        #expect(breakdown.rows.first { $0.accountId == 2 }?.cash == 0)
        #expect(breakdown.rows.first { $0.accountId == 2 }?.holdings == 20)
        #expect(breakdown.rows.first { $0.accountId == 1 }?.cash == 4)
        #expect(breakdown.rows.first { $0.accountId == 3 }?.label == "#3")
        let unconverted = OpenAPI.NetWorthByAccountResponse(
            currency: "EUR",
            rows: [
                .init(
                    accountId: 1, name: "Cash", type: "bank", cashCurrency: "CHF", cash: nil, holdings: 0,
                    total: nil, unconverted: true)
            ], total: nil, unconvertedAccountIds: [1])
        #expect(NetWorthAccountRow.rows(from: unconverted) == nil)
    }
    @Test func theDisplayedBreakdownTotalIsTheServerSum() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth")))
        #expect(model.accountRows?.count == 1)
        #expect(model.accountsTotal == 10)
        #expect(await service.byAccountCurrencies == ["EUR"])
    }
    @Test func unavailableBreakdownDoesNotSuppressTheHeadline() async throws {
        let service = NetWorthFake()
        await service.failBreakdown()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: try #require(NativeRoute("/portfolio/net-worth")))
        #expect(model.data?.current.netWorth == 100)
        #expect(model.accountRows == nil)
        #expect(model.accountsError != nil)
        #expect(model.error == nil)
    }
    @Test func priceRefreshHonorsOfflineAndRefreshesAllCurrentSurfaces() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service, now: { Date(timeIntervalSince1970: 1_760_000_000) })
        let route = try #require(NativeRoute("/portfolio/net-worth"))
        await model.load(currency: "EUR", pageSize: 2, route: route)
        #expect(model.priceFreshness == "2025-01-01T00:00:00Z")
        #expect(model.stalePriceCount == 1)
        model.isOnline = false
        await model.refreshPrices(route: route)
        #expect(await service.refreshes == 0)
        model.isOnline = true
        await model.refreshPrices(route: route)
        #expect(await service.refreshes == 1)
        #expect(model.notice?.key == "portfolio.refreshedPrices")
        #expect(model.notice?.variables == ["n": "1"])
        #expect(model.priceRefreshResult?.staleCount == 1)
        #expect(!model.isRefreshingPrices)
        #expect(await service.calls.count == 4)
    }
}

@MainActor @Suite("Current Net Worth print freezes displayed values")
struct NativeNetWorthPrintTests {
    private let strings = DictionaryStrings(language: .nl, table: ["networth.title": "Nettovermogen"])
    private let theme = ThemeSelection(variant: .default, appearance: .dark)

    @Test func captureAndInertFormattingPerformNoQueriesOrPriceWritesAndRetainCurrentControls() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: NativeRoute("/portfolio/net-worth?period=all")!)
        model.selection = "2025-06-03"
        model.rangeStart = "2025-06-01"
        model.tableQuery.setFilter("date", to: "06-03")
        let calls = await service.calls.count
        let captured = try NativeNetWorthPrintSnapshot.capture(
            model: model, settings: .defaults, strings: strings, theme: theme)
        let presentation = NativeNetWorthPrintPresentation.prepare(captured)
        _ = presentation.money(captured.data.current.netWorth)
        _ = presentation.percent(captured.data.monthlyChangePercent)
        _ = presentation.date("2025-06-03")
        _ = presentation.tick("2025-06-03")
        #expect(await service.calls.count == calls)
        #expect(await service.refreshes == 0)
        #expect(model.selection == "2025-06-03" && model.rangeStart == "2025-06-01")
        #expect(captured.period == .all && captured.currency == "EUR")
        #expect(captured.tableRows.map(\.id) == ["2025-06-03"])
        #expect(captured.tableQuery == model.tableQuery)
        #expect(captured.selection == "2025-06-03" && captured.rangeStart == "2025-06-01")
        #expect(captured.readouts.first(where: { $0.id == "netWorth" })?.value == 3)
        #expect(captured.readouts.first(where: { $0.id == "netWorth" })?.change == 2)
    }

    @Test func acceptedSnapshotSurvivesLaterCurrencyPeriodTableAndSelectionChanges() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: NativeRoute("/portfolio/net-worth?period=all")!)
        model.selection = "2025-06-03"
        let captured = try NativeNetWorthPrintSnapshot.capture(
            model: model, settings: .defaults, strings: strings, theme: theme)
        await model.load(currency: "USD", pageSize: 2, route: NativeRoute("/portfolio/net-worth?period=1m")!)
        model.tableQuery.search = "No matching rows"
        model.selection = nil
        #expect(captured.data.current.netWorth == 100 && captured.currency == "EUR")
        #expect(captured.period == .all && captured.selection == "2025-06-03")
        #expect(captured.tableRows.count == 2 && captured.snapshots.count == 4)
        #expect(captured.theme.appearance == .dark && captured.strings.language == .nl)
        #expect(model.data?.current.netWorth == 200 && model.currency == "USD")
    }

    @Test func captureRejectsMissingOrWrongCurrencyDataWithoutStartingAQuery() async throws {
        let service = NetWorthFake()
        let model = NetWorthModel(service: service)
        #expect(throws: APIError.self) {
            try NativeNetWorthPrintSnapshot.capture(model: model, settings: .defaults, strings: strings, theme: theme)
        }
        #expect(await service.calls.isEmpty)
        await model.load(currency: "EUR", pageSize: 2, route: NativeRoute("/portfolio/net-worth")!)
        let calls = await service.calls.count
        let usd = NativeAppSettings(defaultCurrency: "USD")
        #expect(throws: APIError.self) {
            try NativeNetWorthPrintSnapshot.capture(model: model, settings: usd, strings: strings, theme: theme)
        }
        #expect(await service.calls.count == calls)
    }

    @Test func loadedErrorsAndIncompleteHistoryRemainTheCurrentViewWithoutFetchingMore() async throws {
        let service = NetWorthFake()
        await service.setEmptyPage()
        await service.failBreakdown()
        let model = NetWorthModel(service: service)
        await model.load(currency: "EUR", pageSize: 2, route: NativeRoute("/portfolio/net-worth")!)
        let captured = try NativeNetWorthPrintSnapshot.capture(
            model: model, settings: .defaults, strings: strings, theme: theme)
        #expect(captured.accounts == nil && captured.accountsError != nil)
        #expect(captured.tableRows.isEmpty && captured.tableError != nil)
        #expect(captured.sections.contains(.hero) && captured.sections.contains(.accounts))
        #expect(captured.sections.contains(.table))
        #expect(await service.calls.count == 2)
    }
}

private func snapshot(_ date: String, _ value: Decimal) -> OpenAPI.NetWorthSnapshot {
    .init(date: date, liquid: 0, liabilities: 0, investments: value, netWorth: value)
}
private actor NetWorthFake: NetWorthService {
    struct Call: Sendable {
        let currency: CurrencyCode
        let limit: Int?
        let offset: Int?
    }
    private(set) var calls: [Call] = []
    private(set) var refreshes = 0
    private var emptyPage = false
    private var failingBreakdown = false
    private(set) var byAccountCurrencies: [CurrencyCode] = []
    private var pauseEuro = false
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private var pauseWaiter: CheckedContinuation<Void, Never>?
    func setEmptyPage() { emptyPage = true }
    func failBreakdown() { failingBreakdown = true }
    func pauseEuroHistory() { pauseEuro = true }
    func waitForPause() async { if releaseWaiter == nil { await withCheckedContinuation { pauseWaiter = $0 } } }
    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }
    func netWorth(currency: CurrencyCode, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
        calls.append(Call(currency: currency, limit: limit, offset: offset))
        if currency == "EUR", limit == nil, pauseEuro {
            pauseEuro = false
            await withCheckedContinuation {
                releaseWaiter = $0
                pauseWaiter?.resume()
                pauseWaiter = nil
            }
        }
        let rows: [OpenAPI.NetWorthSnapshot]
        if limit == nil {
            rows = [
                snapshot("2025-06-01", 1), snapshot("2025-06-02", 2), snapshot("2025-06-03", 3),
                snapshot("2025-06-04", 4),
            ]
        } else if emptyPage {
            rows = []
        } else if offset == 0 {
            rows = [snapshot("2025-06-04", 4), snapshot("2025-06-03", 3)]
        } else {
            rows = [snapshot("2025-06-03", 3), snapshot("2025-06-02", 2)]
        }
        return .init(
            unconvertedCurrencies: [],
            current: .init(
                liquid: 0, liabilities: 0, investments: currency == "EUR" ? 100 : 200,
                netWorth: currency == "EUR" ? 100 : 200, currency: currency), monthlyChange: 0, monthlyChangePercent: 0,
            snapshots: rows, snapshotsTotal: limit == nil ? nil : 4, snapshotsLimit: limit, snapshotsOffset: offset)
    }
    func netWorthByAccount(currency: CurrencyCode) async throws -> OpenAPI.NetWorthByAccountResponse {
        byAccountCurrencies.append(currency)
        if failingBreakdown { throw APIError.network("synthetic breakdown failure") }
        return .init(
            currency: currency,
            rows: [
                .init(
                    accountId: 1, name: "Cash", type: "bank", cashCurrency: "EUR", cash: 10, holdings: 0, total: 10,
                    unconverted: false)
            ], total: 10, unconvertedAccountIds: [])
    }
    func netWorthPrices() async throws -> [NetWorthInvestmentPrice] {
        try JSONDecoder().decode(
            [NetWorthInvestmentPrice].self,
            from: Data(
                #"[{"id":1,"price_provider":"manual","is_active":true},{"id":2,"price_provider":"yahoo","price_updated_at":"2025-01-01T00:00:00Z","is_active":true}]"#
                    .utf8))
    }
    func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh {
        refreshes += 1
        return .init(updated: 1, total: 1, message: nil, prices: nil, priceSources: ["synthetic": "cached"])
    }
}
