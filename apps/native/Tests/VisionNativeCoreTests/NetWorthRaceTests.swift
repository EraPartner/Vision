import Foundation
import Testing

@testable import VisionNativeCore

@MainActor
@Suite("Net Worth refresh and pagination races")
struct NetWorthRaceTests {
    @Test func fullReloadDuringPaginationDoesNotLeaveTheLoadingFlagStuck() async throws {
        let service = NetWorthRaceService()
        let model = NetWorthModel(service: service)
        let route = NativeRoute(path: "/portfolio/net-worth")
        await model.load(currency: "EUR", pageSize: 2, route: route)
        await service.pauseNextPage()
        let oldPage = Task { await model.loadMore() }
        await service.waitForPause()
        #expect(model.isFetchingMore)
        await model.load(currency: "EUR", pageSize: 2, route: route, force: true)
        #expect(!model.isFetchingMore)
        #expect(model.tableSnapshots.map(\.date) == ["2025-06-06", "2025-06-05"])
        await service.release()
        await oldPage.value
        #expect(!model.isFetchingMore)
        #expect(model.tableSnapshots.map(\.date) == ["2025-06-06", "2025-06-05"])
        await model.loadMore()
        #expect(model.tableSnapshots.map(\.date) == ["2025-06-06", "2025-06-05", "2025-06-04", "2025-06-03"])
        #expect(await service.pageOffsets == [0, 2, 0, 2])
        #expect(model.hasMore && !model.isFetchingMore)
    }

    @Test func priceRefreshPreservesThePeriodSelectedWhileItsRequestWasRunning() async throws {
        let service = NetWorthRaceService()
        let model = NetWorthModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        var receipts: [PortfolioPriceRefreshReceipt] = []
        model.didPriceRefresh = { receipts.append($0) }
        let initial = try #require(NativeRoute("/portfolio/net-worth?period=1m"))
        let updated = try #require(NativeRoute("/portfolio/net-worth?period=all"))
        await model.load(currency: "EUR", pageSize: 2, route: initial)
        #expect(model.period == .month)
        await service.pauseRefresh()
        let refresh = Task { await model.refreshPrices(route: initial) }
        await service.waitForPause()
        await model.load(currency: "EUR", pageSize: 2, route: updated)
        #expect(model.period == .all)
        await service.release()
        await refresh.value
        #expect(model.period == .all)
        #expect(!model.isRefreshingPrices)
        #expect(await service.refreshes == 1)
        #expect(receipts.count == 1 && receipts.first?.result?.total == 1 && receipts.first?.error == nil)
        #expect(center.entries.isEmpty && model.notice == nil)
        #expect(await service.pageOffsets == [0, 0])
    }
}

private actor NetWorthRaceService: NetWorthService {
    var pageOffsets: [Int] = []
    var refreshes = 0
    private var pausedOperation: String?
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func pauseNextPage() { pausedOperation = "page" }
    func pauseRefresh() { pausedOperation = "refresh" }
    func waitForPause() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        held?.resume()
        held = nil
    }
    private func wait(_ operation: String) async {
        guard pausedOperation == operation else { return }
        pausedOperation = nil
        await withCheckedContinuation {
            held = $0
            entered?.resume()
            entered = nil
        }
    }
    func netWorth(currency: CurrencyCode, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
        let rows = (1...6).map { day in
            OpenAPI.NetWorthSnapshot(
                date: "2025-06-0\(day)", liquid: Decimal(day), liabilities: 0,
                investments: 0, netWorth: Decimal(day))
        }
        let snapshots: [OpenAPI.NetWorthSnapshot]
        if let limit, let offset {
            pageOffsets.append(offset)
            if offset > 0 { await wait("page") }
            snapshots = Array(rows.reversed().dropFirst(offset).prefix(limit))
        } else {
            snapshots = rows
        }
        return .init(
            unconvertedCurrencies: [],
            current: .init(liquid: 6, liabilities: 0, investments: 0, netWorth: 6, currency: currency),
            monthlyChange: 0, monthlyChangePercent: 0, snapshots: snapshots,
            snapshotsTotal: limit == nil ? nil : 6, snapshotsLimit: limit, snapshotsOffset: offset)
    }
    func netWorthByAccount(currency: CurrencyCode) async throws -> OpenAPI.NetWorthByAccountResponse {
        .init(currency: currency, rows: [], total: 0, unconvertedAccountIds: [])
    }
    func netWorthPrices() async throws -> [NetWorthInvestmentPrice] { [] }
    func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh {
        refreshes += 1
        await wait("refresh")
        return .init(updated: 1, total: 1, message: nil, prices: nil, priceSources: nil)
    }
}
