import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Shared FX receipt expires the rates screen cache") @MainActor
struct ExchangeRatesInvalidationTests {
    @Test func sharedStoredStatusReceiptCallbackRunsOnlyAfterProviderSuccess() async {
        let service = InvalidatedRatesFixture()
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        var receipts = 0
        model.didRefreshRates = { receipts += 1 }
        await model.refresh()
        #expect(receipts == 1)
        #expect(await service.reads == 2)
        await service.failNextRefresh()
        await model.refresh()
        #expect(receipts == 1 && model.notice?.key == "exchangeRates.refreshError")
        #expect(await service.reads == 2)
        #expect(await service.refreshes == 2)
    }

    @Test func ownRefreshAlsoInvalidatesAnOlderReadAndDoesNotRepeatTheProviderPost() async {
        let service = InvalidatedRatesFixture()
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        await service.pauseNextRead()
        let older = Task { await model.retry() }
        await service.waitForRead()
        let refreshing = Task { await model.refresh() }
        await service.waitForRefresh()
        while model.isRefreshPending { await Task.yield() }
        await service.releaseRead()
        await older.value
        await refreshing.value
        #expect(model.data?.source == .unknown("fresh"))
        #expect(await service.reads == 3)
        #expect(await service.refreshes == 1)
        #expect(model.notice?.key == "exchangeRates.refreshSuccess")
    }

    @Test func sharedRefreshWhileAnOlderGetIsActiveKeepsKnownRatesAndGetsTheNewReceiptExactlyOnce() async {
        let service = InvalidatedRatesFixture()
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        let cached = model.data
        await service.pauseNextRead()
        let older = Task { await model.retry() }
        await service.waitForRead()
        model.invalidate()
        var retryStarted = false
        let newer = Task {
            retryStarted = true
            await model.retry()
        }
        while !retryStarted { await Task.yield() }
        #expect(model.data == cached)
        await service.releaseRead()
        await older.value
        await newer.value
        #expect(model.data?.source == .unknown("fresh"))
        #expect(await service.reads == 3)
        #expect(await service.refreshes == 0)
        #expect(!model.isFetching)
    }

    @Test func invalidationKeepsKnownRatesAndNextAppearanceReadsStoredRatesWithoutAnotherProviderRefresh() async {
        let service = InvalidatedRatesFixture()
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        let cached = model.data
        #expect(cached?.source == .fallback)
        model.invalidate()
        #expect(model.data == cached && !model.isFetching && model.notice == nil)
        #expect(await service.reads == 1)
        #expect(await service.refreshes == 0)
        await model.appear()
        #expect(model.data?.source == .database)
        #expect(await service.reads == 2)
        #expect(await service.refreshes == 0)
    }
}

private actor InvalidatedRatesFixture: ExchangeRatesService {
    private(set) var reads = 0
    private(set) var refreshes = 0
    private var pauseRead = false
    private var readGate: CheckedContinuation<Void, Never>?
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var refreshWaiter: CheckedContinuation<Void, Never>?
    private var failRefresh = false
    func failNextRefresh() { failRefresh = true }
    func pauseNextRead() { pauseRead = true }
    func waitForRead() async {
        if readGate == nil { await withCheckedContinuation { readWaiter = $0 } }
    }
    func releaseRead() {
        readGate?.resume()
        readGate = nil
    }
    func waitForRefresh() async {
        if refreshes == 0 { await withCheckedContinuation { refreshWaiter = $0 } }
    }
    func exchangeRates() async throws -> OpenAPI.ExchangeRates {
        reads += 1
        let snapshot = reads
        if pauseRead {
            pauseRead = false
            await withCheckedContinuation {
                readGate = $0
                readWaiter?.resume()
                readWaiter = nil
            }
        }
        return .init(
            totalRates: 0, rates: [],
            source: snapshot == 1 ? .fallback : (snapshot == 2 ? .database : .unknown("fresh")), isStale: snapshot == 1)
    }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage {
        refreshes += 1
        refreshWaiter?.resume()
        refreshWaiter = nil
        if failRefresh {
            failRefresh = false
            throw APIError.network("Synthetic provider failure")
        }
        return .init(message: "Synthetic refresh")
    }
}
