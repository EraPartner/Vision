import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Shared FX receipt expires the rates screen cache") @MainActor
struct ExchangeRatesInvalidationTests {
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
    func exchangeRates() async throws -> OpenAPI.ExchangeRates {
        reads += 1
        return .init(
            totalRates: 0, rates: [], fallbackRates: [:],
            source: reads == 1 ? "fallback" : "database", isStale: reads == 1)
    }
    func refreshExchangeRates() async throws -> OpenAPI.InfoMessage {
        refreshes += 1
        return .init(message: "Synthetic refresh")
    }
}
