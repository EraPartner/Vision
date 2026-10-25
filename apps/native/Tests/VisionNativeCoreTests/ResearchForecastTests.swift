import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Research Forecast authority and draft scopes")
struct ResearchForecastTests {
    @Test func authoritativeDecimalBandsAndUnavailableResponsesRoundTripWithoutFabricatedMoney() throws {
        var raw = forecastFixture()
        raw["projected"]?["p50"] = .number(Decimal(string: "123456789.1234567890123456789")!)
        raw["future"] = .array([.null, .string("retain")])
        let value = try ResearchForecastData(raw: raw)
        #expect(value.projected?.p50 == Decimal(string: "123456789.1234567890123456789"))
        #expect(try TaxValue(encoding: value) == raw)
        let missing = try ResearchForecastData(
            raw: .object(["available": .bool(false), "reason": .string("no_holdings")]))
        #expect(missing.startValue == nil && missing.projected == nil && missing.points.isEmpty)
        #expect(throws: APIError.self) {
            try ResearchForecastData(raw: .object(["available": .bool(false), "reason": .string("invented")]))
        }
        var overflow = raw
        overflow["projected"]?["p50"] = .null
        #expect(throws: APIError.self) { try ResearchForecastData(raw: overflow) }
        overflow = raw
        overflow["projected"]?["mean"] = .null
        #expect(throws: APIError.self) { try ResearchForecastData(raw: overflow) }
        overflow = raw
        overflow["targetValue"] = .null
        #expect(throws: APIError.self) { try ResearchForecastData(raw: overflow) }
    }
    @Test func requestMappingRetainsDecimalPrecisionAndOptionalAbsenceAndRawMeta() async throws {
        let transport = ForecastTransport()
        let input: TaxValue = .object([
            "horizonMonths": .number(60), "monthlyContribution": .number(Decimal(string: "1234.1234567890123456789")!),
            "currency": .string("EUR"),
        ])
        let result = try await client(transport).researchPortfolioForecast(input)
        let request = try #require(await transport.forecasts.first)
        #expect(request["monthly_contribution"] == input["monthlyContribution"])
        #expect(request["horizon_months"] == .number(60) && request["horizonMonths"] == nil)
        #expect(request["target_value"] == nil && request["goal_month"] == nil)
        #expect(result.meta.provider == "synthetic" && result.meta.raw?["future"]?.stringValue == "preserve")
    }
    @Test func localeInputsInvalidationAndDebounceSendOnlyTheFinalValidDraft() async throws {
        let transport = ForecastTransport()
        let model = ResearchForecastModel(service: client(transport), debounceMilliseconds: 5)
        await model.load()
        #expect(model.visibleForecast?.available == true)
        model.contributionText = "1.234,50"
        model.targetText = "2.500,00"
        #expect(model.visibleForecast == nil && model.isDebouncing)
        await model.load()
        let submitted = try #require(await transport.forecasts.last)
        #expect(submitted["monthly_contribution"] == .number(Decimal(string: "1234.5")!))
        #expect(submitted["target_value"] == .number(2500))
        model.contributionText = "-1"
        #expect(model.contributionInvalid && model.visibleForecast == nil)
        await model.load()
        #expect(await transport.forecasts.count == 2)
        model.contributionText = "300"
        model.contributionText = "400"
        await model.load()
        #expect(await transport.forecasts.last?["monthly_contribution"] == .number(400))
        #expect(await transport.forecasts.count == 3)
    }
    @Test func cacheFiveMinuteScopeAndLeaveResetDoNotTriggerHiddenReconnectReads() async throws {
        let transport = ForecastTransport()
        let clock = ForecastTestClock()
        let model = ResearchForecastModel(
            service: client(transport), cache: .init(now: { clock.read() }), debounceMilliseconds: 0)
        await model.load()
        model.didDisappear()
        await model.load()
        #expect(await transport.forecasts.count == 1)
        clock.advance(301)
        model.didDisappear()
        await model.load()
        #expect(await transport.forecasts.count == 2)
        model.contributionText = "900"
        model.returnSource = "blended"
        model.didDisappear()
        #expect(model.contributionText.isEmpty && model.returnSource == "historical" && model.blendPct == 50)
        model.isOnline = false
        model.isOnline = true
        for _ in 0..<20 { await Task.yield() }
        #expect(await transport.forecasts.count == 2)
    }
    @Test func lateOldForecastCannotReplaceTheCurrentWindowOrRestoreExitedDraft() async throws {
        let transport = ForecastTransport()
        let model = ResearchForecastModel(service: client(transport), debounceMilliseconds: 0)
        await transport.pauseNextForecast()
        let first = Task { await model.load() }
        await transport.waitForPause()
        model.horizonMonths = 36
        await model.load()
        #expect(model.visibleForecast?.horizonMonths == 36)
        await transport.release()
        await first.value
        #expect(model.visibleForecast?.horizonMonths == 36)
        await transport.pauseNextForecast()
        let last = Task { await model.load(force: true) }
        await transport.waitForPause()
        model.didDisappear()
        await transport.release()
        await last.value
        #expect(model.visibleForecast == nil && model.horizonMonths == 60 && !model.isFetching)
    }
    @Test func coordinatorRepeatedLoadsPreserveInputsAndRealExitResetsThem() async throws {
        let screens = ResearchForecastScreens(service: client(ForecastTransport()))
        await screens.didAppear()
        screens.model.contributionText = "42"
        await screens.didAppear()
        #expect(screens.model.contributionText == "42")
        screens.configure(settings: .defaults)
        #expect(screens.model.contributionText == "42")
        screens.didDisappear()
        #expect(screens.model.contributionText.isEmpty)
    }
    private func client(_ transport: ForecastTransport) -> APIClient {
        .init(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
    }
}

private func forecastFixture(horizon: TaxValue = .number(60)) -> TaxValue {
    let bands: [String: TaxValue] = [
        "p10": .number(8000), "p25": .number(9000), "p50": .number(10000), "p75": .number(11000),
        "p90": .number(12000),
    ]
    return .object([
        "available": .bool(true), "currency": .string("EUR"), "method": .string("parametric"), "horizonMonths": horizon,
        "paths": .number(1000), "seed": .string("synthetic"), "historyDays": .number(100),
        "flowArtifactDays": .number(0),
        "lowConfidence": .bool(false), "startValue": .number(5000), "startInvested": .number(4000),
        "monthlyContribution": .number(600),
        "totalContributions": .number(1000), "netInvested": .number(5000),
        "expectedAnnualReturn": .number(Decimal(string: "0.05")!),
        "historicalAnnualReturn": .number(Decimal(string: "0.05")!),
        "annualVolatility": .number(Decimal(string: "0.2")!),
        "forwardBlend": .number(0), "usedForward": .bool(false), "forwardHoldings": .array([]),
        "projected": .object(bands.merging(["mean": .number(10000)]) { a, _ in a }),
        "probBelowInvested": .number(Decimal(string: "0.1")!),
        "points": .array([
            .object(
                bands.merging(["monthIndex": .number(1), "date": .string("2026-02-01"), "netInvested": .number(4600)]) {
                    a, _ in a
                })
        ]),
    ])
}
private final class ForecastTestClock: @unchecked Sendable {
    private let lock = NSLock()
    private var date = Date(timeIntervalSince1970: 1_767_225_600)
    func read() -> Date { lock.withLock { date } }
    func advance(_ seconds: TimeInterval) { lock.withLock { date.addTimeInterval(seconds) } }
}
private actor ForecastTransport: APITransport {
    private(set) var forecasts: [TaxValue] = []
    private var pause = false
    private var paused: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func pauseNextForecast() { pause = true }
    func waitForPause() async { if paused == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        paused?.resume()
        paused = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let output: TaxValue
        switch request.url.path {
        case "/api/research/portfolio-forecast":
            let input = try JSONDecoder().decode(TaxValue.self, from: request.body ?? Data())
            forecasts.append(input)
            if pause {
                pause = false
                await withCheckedContinuation {
                    paused = $0
                    entered?.resume()
                    entered = nil
                }
            }
            output = forecastFixture(horizon: input["horizon_months"] ?? .number(60))
        default: throw APIError.invalidRequest("Unexpected Forecast fixture route")
        }
        return .init(
            status: 200,
            body: try APIBody.encode(
                TaxValue.object([
                    "ok": .bool(true), "data": output,
                    "meta": .object([
                        "provider": .string("synthetic"), "source": .string("cache"), "future": .string("preserve"),
                    ]),
                ])))
    }
}
