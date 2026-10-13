import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Shared FX receipt expires the rates screen cache") @MainActor
struct ExchangeRatesInvalidationTests {
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
        #expect(model.data?.source == "fresh")
        #expect(await service.reads == 3)
        #expect(await service.refreshes == 0)
        #expect(!model.isFetching)
    }

    @Test func invalidationKeepsKnownRatesAndNextAppearanceReadsStoredRatesWithoutAnotherProviderRefresh() async {
        let service = InvalidatedRatesFixture()
        let model = ExchangeRatesModel(service: service)
        await model.appear()
        let cached = model.data
        #expect(cached?.source == "fallback")
        model.invalidate()
        #expect(model.data == cached && !model.isFetching && model.notice == nil)
        #expect(await service.reads == 1)
        #expect(await service.refreshes == 0)
        await model.appear()
        #expect(model.data?.source == "database")
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
    func pauseNextRead() { pauseRead = true }
    func waitForRead() async {
        if readGate == nil { await withCheckedContinuation { readWaiter = $0 } }
    }
    func releaseRead() {
        readGate?.resume()
        readGate = nil
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
            totalRates: 0, rates: [], fallbackRates: [:],
            source: snapshot == 1 ? "fallback" : (snapshot == 2 ? "database" : "fresh"), isStale: snapshot == 1)
    }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage {
        refreshes += 1
        return .init(message: "Synthetic refresh")
    }
}
