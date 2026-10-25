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
    @Test func accountCompositionKeepsHoldingsOnlyWalletsAndUnassignedAmounts() throws {
        let accounts = [
            account(1, "Cash", "EUR", "bank", 10), account(2, "Wallet", "EUR", "wallet", 999),
            account(3, "Foreign", "USD", "bank", 8),
        ]
        let partitions = try JSONDecoder().decode(
            NetWorthPartitions.self,
            from: Data(
                #"{"currency":"EUR","byAccount":[{"account_id":2,"currentValue":20},{"account_id":null,"currentValue":5},{"account_id":2,"currentValue":0.125}]}"#
                    .utf8))
        let rows = try NetWorthAccountRow.build(
            accounts: accounts, partitions: partitions, rates: rates(), currency: "EUR")
        #expect(rows.first { $0.accountId == 2 }?.cash == 0)
        #expect(rows.first { $0.accountId == 2 }?.holdings == Decimal(string: "20.13"))
        #expect(rows.first { $0.accountId == 3 }?.cash == 4)
        #expect(rows.last?.accountId == nil)
        #expect(rows.last?.total == 5)
        let missingRates = OpenAPI.ExchangeRates(
            totalRates: 0, rates: [], source: "synthetic", isStale: false)
        #expect(throws: APIError.self) {
            try NetWorthAccountRow.build(
                accounts: accounts, partitions: partitions, rates: missingRates, currency: "EUR")
        }
    }
    @Test func unavailableBreakdownDoesNotSuppressTheHeadline() async throws {
        let service = NetWorthFake()
        await service.failRates()
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
        await service.failRates()
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
private func account(_ id: Int, _ name: String, _ currency: String, _ type: String, _ balance: Decimal)
    -> OpenAPI.Account
{
    .init(
        id: id, name: name, currency: currency, type: type, liquidityClass: "cash", spendable: true, inNetWorth: true,
        taxWrapper: "none", owner: "me", multiCurrencyCash: false, hasCashSleeve: true, computedBalance: balance,
        isActive: true, createdAt: "2025-01-01", updatedAt: "2025-01-01")
}
private func rates() -> OpenAPI.ExchangeRates {
    .init(
        totalRates: 1,
        rates: [.init(currency: "USD", rateToEur: Decimal(string: "0.5")!, rateDate: "2026-01-01", fetchedAt: "2026-01-01T00:00:00Z")],
        source: "synthetic", isStale: false)
}
private actor NetWorthFake: NetWorthService {
    struct Call: Sendable {
        let currency: String
        let limit: Int?
        let offset: Int?
    }
    private(set) var calls: [Call] = []
    private(set) var refreshes = 0
    private var emptyPage = false
    private var failingRates = false
    private var pauseEuro = false
    private var releaseWaiter: CheckedContinuation<Void, Never>?
    private var pauseWaiter: CheckedContinuation<Void, Never>?
    func setEmptyPage() { emptyPage = true }
    func failRates() { failingRates = true }
    func pauseEuroHistory() { pauseEuro = true }
    func waitForPause() async { if releaseWaiter == nil { await withCheckedContinuation { pauseWaiter = $0 } } }
    func release() {
        releaseWaiter?.resume()
        releaseWaiter = nil
    }
    func netWorth(currency: String, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
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
    func netWorthAccounts() async throws -> [OpenAPI.Account] { [account(1, "Cash", "EUR", "bank", 10)] }
    func netWorthPartitions(currency: String) async throws -> NetWorthPartitions {
        try JSONDecoder().decode(
            NetWorthPartitions.self, from: Data("{\"currency\":\"\(currency)\",\"byAccount\":[]}".utf8))
    }
    func netWorthRates() async throws -> OpenAPI.ExchangeRates {
        if failingRates { throw APIError.network("synthetic rate failure") }
        return rates()
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
