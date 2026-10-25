import Foundation
import Testing

@testable import VisionNativeCore

@Suite("App-lifetime shell banners and occurrence dismissals") @MainActor
struct NativeShellNotificationsTests {
    @Test func refreshReceiptReplacesAnOlderPendingStatusReadWithoutRepeatingTheProviderPost() async {
        let service = BannerService()
        let model = ShellFXStatusModel(service: service)
        await model.load()
        await service.pauseNextFXRead()
        let older = Task { await model.load(force: true) }
        await service.waitForFXRead()
        var receiptSeen = false
        model.didRefreshRates = {
            await service.setFXSource(.database)
            receiptSeen = true
        }
        let refreshing = Task { await model.refresh() }
        while !receiptSeen { await Task.yield() }
        #expect(model.data?.source == .fallback)
        await service.releaseFXRead()
        await older.value
        await refreshing.value
        #expect(model.data?.source == .database && !model.shouldShow)
        #expect(await service.fxReads == 3)
        #expect(await service.refreshes == 1)
    }

    @Test func passiveFXReadUsesOnlyStoredRatesAndDoesNotRetry() async {
        let transport = FakeTransport([.response(503, ""), .response(200, APIClientTests.ratesBody)])
        let client = APIClient(baseURL: { APIClientTests.base }, transport: transport, sleep: { _ in })
        do {
            _ = try await client.notificationExchangeRates()
            Issue.record("A failed passive read must remain a failure")
        } catch {}
        #expect(await transport.requests.count == 1)
        #expect(
            await transport.requests.first?.url.absoluteString
                == "http://127.0.0.1:54331/api/info/exchange-rates?db_only=true")
    }

    @Test func fxSuccessfulReadIsFreshForExactlySixtySecondsAndFailureKeepsCachedWarning() async {
        let clock = BannerClock()
        let service = BannerService()
        let model = ShellFXStatusModel(service: service, now: { clock.date })
        await model.load()
        #expect(model.shouldShow)
        clock.advance(59)
        await model.refreshIfStale()
        #expect(await service.fxReads == 1)
        clock.advance(1)
        await service.failNextFXRead()
        await model.refreshIfStale()
        #expect(await service.fxReads == 2)
        #expect(model.shouldShow && model.readError != nil && model.notice == nil)
    }

    @Test func fxDismissalTTLIsOnlyEvaluatedWhenTheShellLoadsAndStorageFailureKeepsSessionDismissal() async {
        let clock = BannerClock()
        let storage = BannerStorage()
        storage.values[.fxDismissedAt] = String(clock.date.timeIntervalSince1970 * 1000 - 3_599_999)
        let model = ShellFXStatusModel(service: BannerService(), storage: storage.callbacks, now: { clock.date })
        await model.load()
        #expect(model.dismissed && !model.shouldShow)
        clock.advance(0.001)
        let boundaryShell = ShellFXStatusModel(
            service: BannerService(), storage: storage.callbacks, now: { clock.date })
        await boundaryShell.load()
        #expect(!boundaryShell.dismissed)
        clock.advance(3_600)
        await model.load(force: true)
        #expect(model.dismissed && storage.reads.count == 2)
        let nextShell = ShellFXStatusModel(service: BannerService(), storage: storage.callbacks, now: { clock.date })
        await nextShell.load()
        #expect(!nextShell.dismissed && nextShell.shouldShow)
        storage.failWrites = true
        nextShell.dismiss()
        await nextShell.flushStorage()
        #expect(nextShell.dismissed)
    }

    @Test func fxPendingOfflineRefreshRunsOnceOnReconnectAndPublishesTheRealReceipt() async {
        let service = BannerService()
        let model = ShellFXStatusModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        var invalidations = 0
        model.didRefreshRates = { invalidations += 1 }
        model.isOnline = false
        await model.refresh()
        await model.refresh()
        #expect(model.isRefreshing)
        #expect(await service.refreshes == 0)
        model.isOnline = true
        await service.waitForRefresh()
        // The callback marks completion after the accepted mutation and before the DB-only read.
        while model.isRefreshing { await Task.yield() }
        #expect(await service.refreshes == 1)
        #expect(await service.fxReads == 1)
        #expect(invalidations == 1)
        #expect(center.entries.last?.notice.key == "exchangeRates.refreshSuccess")
    }

    @Test func acceptedFXRefreshSurvivesShellRetirementButStartsNoRetiredRead() async {
        let service = BannerService()
        await service.pauseNextRefresh()
        let model = ShellFXStatusModel(service: service)
        let refreshing = Task { await model.refresh() }
        await service.waitForRefresh()
        model.didDisappear()
        await service.releaseRefresh()
        await refreshing.value
        #expect(await service.fxReads == 0)
        #expect(await service.refreshes == 1)
        #expect(model.notice?.key == "exchangeRates.refreshSuccess" && !model.isRefreshing)
    }

    @Test func occurrenceDismissalsPrunePastDatesAndLegacyIDsAndDriveTheGlobalDockCount() async {
        let clock = BannerClock()
        let storage = BannerStorage()
        storage.values[.upcomingDismissals] = "[8,\"8\",\"1:2026-03-28\",\"2:2026-03-29\",\"bad\",\"2:2026-03-29\"]"
        let service = BannerService()
        await service.setUpcoming([
            payment(1, "2026-03-29"), payment(2, "2026-03-29T00:00:00.000Z"),
            payment(3, "2026-03-30", executed: true), payment(4, "2026-03-31", executed: true, recurring: true),
        ])
        let model = ShellUpcomingPaymentsModel(
            service: service, storage: storage.callbacks,
            timeZone: TimeZone(identifier: "Europe/Brussels")!, now: { clock.date })
        var badges: [Int] = []
        model.didChangeDockBadge = { badges.append($0) }
        await model.load()
        #expect(model.dismissalKeys == ["2:2026-03-29"])
        #expect(model.visibleUpcoming.map(\.id) == [1, 4])
        #expect(badges.last == 2)
        #expect(await service.windows.first?.start == "2026-03-29")
        #expect(await service.windows.first?.end == "2026-04-05")
        model.dismiss(model.visibleUpcoming[0])
        await model.flushStorage()
        #expect(badges.last == 1)
        #expect(storage.values[.upcomingDismissals]?.contains("1:2026-03-29") == true)
        model.dismissAll()
        await model.flushStorage()
        #expect(!model.shouldShow && badges.last == 0)
    }

    @Test func recurringPaymentNextOccurrenceReappearsWithoutDroppingOtherDismissals() async {
        let service = BannerService()
        await service.setUpcoming([payment(7, "2026-03-29", recurring: true)])
        let model = ShellUpcomingPaymentsModel(service: service)
        await model.load()
        model.dismissAll()
        await service.setUpcoming([payment(7, "2026-04-01", recurring: true)])
        model.invalidate()
        await model.refreshIfStale()
        #expect(model.visibleUpcoming.first?.id == 7)
        #expect(model.dismissalKeys == ["7:2026-03-29"])
    }

    @Test func upcomingCacheUsesFiveMinutesAndRekeysTheCalendarWindowAtLocalMidnight() async {
        let clock = BannerClock()
        let service = BannerService()
        let model = ShellUpcomingPaymentsModel(
            service: service,
            timeZone: TimeZone(identifier: "Europe/Brussels")!, now: { clock.date })
        await model.load()
        clock.advance(299)
        await model.refreshIfStale()
        #expect(await service.windows.count == 1)
        clock.advance(1)
        await model.refreshIfStale()
        #expect(await service.windows.count == 2)
        clock.advance(86_400)
        await model.refreshIfStale()
        #expect(await service.windows.last?.start == "2026-03-30")
        #expect(await service.windows.last?.end == "2026-04-06")
    }

    @Test func delayedStorageSnapshotCannotRewindAUserDismissalAndWritesKeepTheirOrder() async {
        let storage = BannerStorage()
        storage.pauseRead = true
        let service = BannerService()
        let row = payment(5, "2026-03-29")
        await service.setUpcoming([row])
        let model = ShellUpcomingPaymentsModel(service: service, storage: storage.callbacks)
        let loading = Task { await model.load() }
        await storage.waitForRead()
        model.dismiss(row)
        storage.releaseRead()
        await loading.value
        await model.flushStorage()
        #expect(model.dismissalKeys == ["5:2026-03-29"] && !model.shouldShow)
        #expect(storage.writes.last?.1 == "[\"5:2026-03-29\"]")
    }

    @Test func retiringTheWholeGraphSuppressesLateUpcomingAndResetsTheDockBadge() async {
        let service = BannerService()
        await service.pauseNextUpcoming()
        let model = ShellUpcomingPaymentsModel(service: service)
        var badges: [Int] = []
        model.didChangeDockBadge = { badges.append($0) }
        let loading = Task { await model.load() }
        await service.waitForUpcoming()
        model.didDisappear()
        await service.releaseUpcoming()
        await loading.value
        #expect(model.upcoming == nil && !model.isFetching)
        #expect(badges == [0])
        await model.load(force: true)
        #expect(await service.windows.count == 1)
        model.dismiss(payment(9, "2026-03-29"))
        #expect(model.dismissalKeys.isEmpty)
    }

    @Test func repeatedRetirementCannotClearTheFreshGraphsDockBadge() async {
        let service = BannerService()
        await service.setUpcoming([payment(1, "2026-03-29")])
        var badge = -1
        let old = ShellUpcomingPaymentsModel(service: service)
        old.didChangeDockBadge = { badge = $0 }
        await old.load()
        #expect(badge == 1)
        old.didDisappear()
        #expect(badge == 0 && old.didChangeDockBadge == nil)
        await service.setUpcoming([payment(2, "2026-03-29"), payment(3, "2026-03-30")])
        let fresh = ShellUpcomingPaymentsModel(service: service)
        fresh.didChangeDockBadge = { badge = $0 }
        await fresh.load()
        #expect(badge == 2)
        old.didDisappear()
        old.didDisappear()
        #expect(badge == 2)
    }

    @Test func cancelledStorageReadDoesNotCommitDefaultsAndFailedRestoreCanResumeTheSameModels() async {
        let clock = BannerClock()
        let storage = BannerStorage()
        storage.cancelReads = true
        storage.values[.fxDismissedAt] = String(clock.date.timeIntervalSince1970 * 1000)
        storage.values[.upcomingDismissals] = "[\"1:2026-03-29\"]"
        let service = BannerService()
        await service.setUpcoming([payment(1, "2026-03-29")])
        let fx = ShellFXStatusModel(service: service, storage: storage.callbacks, now: { clock.date })
        let upcoming = ShellUpcomingPaymentsModel(
            service: service, storage: storage.callbacks,
            timeZone: TimeZone(identifier: "UTC")!, now: { clock.date })
        var mirrored: [[String]] = []
        var badges: [Int] = []
        upcoming.didChangeDismissals = { mirrored.append($0) }
        upcoming.didChangeDockBadge = { badges.append($0) }
        await fx.load()
        await upcoming.load()
        #expect(!fx.isStorageLoaded && !upcoming.isStorageLoaded)
        #expect(mirrored.isEmpty && badges.isEmpty)
        storage.cancelReads = false
        await fx.refreshIfStale()
        await upcoming.refreshIfStale()
        #expect(fx.isStorageLoaded && fx.dismissed && !fx.shouldShow)
        #expect(upcoming.isStorageLoaded && !upcoming.shouldShow)
        #expect(mirrored == [["1:2026-03-29"]] && badges == [0])
    }

    @Test func expectedRetiredRefreshCancellationPublishesNoFailureNotice() async {
        let service = BannerService()
        await service.cancelNextRefresh()
        let model = ShellFXStatusModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        await model.refresh()
        #expect(!model.isRefreshing && model.notice == nil && center.entries.isEmpty)
        #expect(await service.fxReads == 0)
    }

    private func payment(_ id: Int, _ date: String, executed: Bool = false, recurring: Bool = false)
        -> OpenAPI.PlannedTransaction
    {
        .init(
            id: PlannedTransactionID(rawValue: id), plannedDate: date, amount: Decimal(string: "-12.34")!, isRecurring: recurring,
            isExecuted: executed, executionCount: executed ? 1 : 0, isActive: true, links: [])
    }
}

private final class BannerClock: @unchecked Sendable {
    private let lock = NSLock()
    private var instant = Date(timeIntervalSince1970: 1_774_742_400)  // 2026-03-29 00:00 UTC, DST weekend.
    var date: Date { lock.withLock { instant } }
    func advance(_ seconds: TimeInterval) { lock.withLock { instant.addTimeInterval(seconds) } }
}

@MainActor private final class BannerStorage {
    var values: [NativeShellNotificationStorage.Key: String] = [:]
    var reads: [NativeShellNotificationStorage.Key] = []
    var writes: [(NativeShellNotificationStorage.Key, String)] = []
    var failWrites = false
    var cancelReads = false
    var pauseRead = false
    private var readGate: CheckedContinuation<Void, Never>?
    private var readWaiter: CheckedContinuation<Void, Never>?
    var callbacks: NativeShellNotificationStorage {
        .init(
            read: { [self] key in
                reads.append(key)
                if cancelReads { throw CancellationError() }
                let snapshot = values[key]
                if pauseRead {
                    pauseRead = false
                    await withCheckedContinuation {
                        readGate = $0
                        readWaiter?.resume()
                        readWaiter = nil
                    }
                }
                return snapshot
            },
            write: { [self] key, value in
                writes.append((key, value))
                if failWrites { throw APIError.network("Synthetic storage failure") }
                values[key] = value
            })
    }
    func waitForRead() async {
        if readGate == nil { await withCheckedContinuation { readWaiter = $0 } }
    }
    func releaseRead() {
        readGate?.resume()
        readGate = nil
    }
}

private actor BannerService: ShellNotificationsService {
    private(set) var fxReads = 0
    private(set) var refreshes = 0
    private(set) var windows: [(start: String, end: String)] = []
    private var upcoming: [OpenAPI.PlannedTransaction] = []
    private var failFX = false
    private var pauseRefresh = false
    private var pauseUpcoming = false
    private var cancelRefresh = false
    private var pauseFX = false
    private var fxSource: OpenAPI.ExchangeRates.Source = .fallback
    private var fxGate: CheckedContinuation<Void, Never>?
    private var fxWaiter: CheckedContinuation<Void, Never>?
    private var refreshGate: CheckedContinuation<Void, Never>?
    private var refreshWaiter: CheckedContinuation<Void, Never>?
    private var upcomingGate: CheckedContinuation<Void, Never>?
    private var upcomingWaiter: CheckedContinuation<Void, Never>?
    func setUpcoming(_ rows: [OpenAPI.PlannedTransaction]) { upcoming = rows }
    func failNextFXRead() { failFX = true }
    func pauseNextRefresh() { pauseRefresh = true }
    func pauseNextUpcoming() { pauseUpcoming = true }
    func cancelNextRefresh() { cancelRefresh = true }
    func pauseNextFXRead() { pauseFX = true }
    func setFXSource(_ source: OpenAPI.ExchangeRates.Source) { fxSource = source }
    func waitForFXRead() async {
        if fxGate == nil { await withCheckedContinuation { fxWaiter = $0 } }
    }
    func releaseFXRead() {
        fxGate?.resume()
        fxGate = nil
    }
    func notificationExchangeRates() async throws -> OpenAPI.ExchangeRates {
        fxReads += 1
        if failFX {
            failFX = false
            throw APIError.network("Synthetic read failure")
        }
        let source = fxSource
        if pauseFX {
            pauseFX = false
            await withCheckedContinuation {
                fxGate = $0
                fxWaiter?.resume()
                fxWaiter = nil
            }
        }
        return .init(totalRates: 0, rates: [], source: source, isStale: false)
    }
    func notificationRefreshExchangeRates() async throws {
        refreshes += 1
        if cancelRefresh {
            cancelRefresh = false
            throw CancellationError()
        }
        if pauseRefresh {
            pauseRefresh = false
            await withCheckedContinuation {
                refreshGate = $0
                refreshWaiter?.resume()
                refreshWaiter = nil
            }
        } else {
            refreshWaiter?.resume()
            refreshWaiter = nil
        }
    }
    func notificationUpcoming(start: String, end: String) async throws -> [OpenAPI.PlannedTransaction] {
        windows.append((start, end))
        let snapshot = upcoming
        if pauseUpcoming {
            pauseUpcoming = false
            await withCheckedContinuation {
                upcomingGate = $0
                upcomingWaiter?.resume()
                upcomingWaiter = nil
            }
        }
        return snapshot
    }
    func waitForRefresh() async {
        if refreshes == 0 { await withCheckedContinuation { refreshWaiter = $0 } }
    }
    func releaseRefresh() {
        refreshGate?.resume()
        refreshGate = nil
    }
    func waitForUpcoming() async {
        if windows.isEmpty { await withCheckedContinuation { upcomingWaiter = $0 } }
    }
    func releaseUpcoming() {
        upcomingGate?.resume()
        upcomingGate = nil
    }
}
