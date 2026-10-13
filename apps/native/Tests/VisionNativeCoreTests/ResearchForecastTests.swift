import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Research Forecast authority, draft scopes and scenario settings")
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
    @Test func lifeDraftRequiresAmountsPairedGoalAndLocalCalendarWindow() throws {
        var draft = validDraft()
        let now = Date(timeIntervalSince1970: 1_767_225_600)  // 2026-01-01 UTC.
        draft.goalValue = "10.000,00"
        draft.goalMonth = "2026-07"
        let parsed = try draft.read(
            numberFormat: .eu, horizonMonths: 12, now: now, timeZone: .gmt, newID: { "source-id" })
        #expect(parsed.goalMonth == 6 && parsed.scenario.goalDate == "2026-07-01")
        var invalidDate = parsed.scenario.raw
        invalidDate["goalDate"] = .string("2026-02-30")
        #expect(throws: APIError.self) { try ResearchLifeScenario(raw: invalidDate) }
        draft.monthlyIncomeLoss = ""
        #expect(throws: APIError.self) { try draft.read(numberFormat: .eu, horizonMonths: 12, now: now) }
        #expect(ResearchLifeScenarioDraft.resolveGoalMonth("2026-13", horizonMonths: 12, now: now) == nil)
        #expect(ResearchLifeScenarioDraft.resolveGoalMonth("2026-07", horizonMonths: 0, now: now) == nil)
        #expect(
            ResearchLifeScenarioDraft.resolveGoalMonth("2026-01", horizonMonths: 12, now: now, timeZone: .gmt) == nil)
        draft = validDraft()
        draft.name = String(repeating: "😀", count: 41)
        #expect(throws: APIError.self) { try draft.read(numberFormat: .eu, horizonMonths: 12, now: now) }
    }
    @Test func lifeCompareIsIndependentFromInvalidMainMoneyAndFailedSavedReadAndUsesServerFacts() async throws {
        let transport = ForecastTransport()
        await transport.failReads(true)
        let life = ResearchLifeScenarioModel(service: client(transport), newID: { "new-source-id" })
        life.configure(
            settings: .defaults,
            forecastInput: .object([
                "horizonMonths": .number(12), "monthlyContribution": .null, "targetValue": .null,
                "currency": .string("EUR"),
            ]))
        await life.loadSaved()
        #expect(life.savedError != nil && !life.canSave)
        life.draft = validDraft()
        await life.run()
        let comparison = try #require(life.comparison)
        #expect(comparison.reducedContribution == 300 && comparison.monthlyDeficit == 0 && comparison.medianGap == -300)
        let requests = await transport.forecasts
        #expect(requests.count == 2 && requests.allSatisfy { $0["seed"] == .string("life-scenario:new-source-id") })
        #expect(requests.allSatisfy { $0["monthly_contribution"] == .number(600) && $0["target_value"] == nil })
        #expect(
            requests.first { $0["monthly_contribution_schedule"] != nil }?["monthly_contribution_schedule"]
                == .array([.number(300), .number(300), .number(300)]))
    }
    @Test func saveUsesPinnedCASAndEditableEuropeanDecimalsAndReadRetryKeepsTheDraft() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport), newID: { "saved-source" })
        await life.loadSaved()
        life.draft = validDraft()
        life.draft.monthlySurplus = "1.234,56"
        await life.saveDraft()
        #expect(life.scenarios.count == 1 && life.draft.monthlySurplus == "1234,56")
        #expect(await transport.writes.first?["expected"] == .object(["exists": .bool(false)]))
        life.draft.name = "Retained edit"
        await transport.failReads(true)
        await life.loadSaved(force: true)
        #expect(life.draft.name == "Retained edit" && !life.canSave)
        await transport.failReads(false)
        await life.loadSaved(force: true)
        #expect(life.draft.name == "Retained edit" && life.canSave)
        await life.saveDraft()
        #expect(
            await transport.writes.last?["expected"]?["value"]?.arrayValue?.first?["name"] == .string("Interruption"))
    }
    @Test func conflictDoesNotRebaseOrRetryTheRejectedSettingsQueue() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport))
        await life.loadSaved()
        life.draft = validDraft()
        await transport.rejectWrites(true)
        await life.saveDraft()
        #expect(life.error != nil)
        await transport.rejectWrites(false)
        await life.loadSaved(force: true)
        await life.saveDraft()
        #expect(await transport.writes.count == 1)
        #expect(life.scenarios.isEmpty && life.error != nil)
    }
    @Test func deleteRemainsAllowedAfterReadFailureAndUndoRestoresPreviousListWithinEightSeconds() async throws {
        let transport = ForecastTransport()
        let clock = ForecastTestClock()
        let life = ResearchLifeScenarioModel(service: client(transport), now: { clock.read() }, newID: { "saved-id" })
        await life.loadSaved()
        life.draft = validDraft()
        await life.saveDraft()
        await transport.failReads(true)
        await life.loadSaved(force: true)
        await life.deleteDraft()
        #expect(life.scenarios.isEmpty && life.undoNotice?.key == "research.lifeScenario.deleted")
        await life.undo()
        #expect(life.scenarios.count == 1 && life.draft.id == "saved-id" && life.undoNotice == nil)
        await life.deleteDraft()
        clock.advance(9)
        let before = await transport.writes.count
        await life.undo()
        #expect(await transport.writes.count == before)
        #expect(life.undoNotice == nil)
    }
    @Test func globalLifeUndoSurvivesRouteExitWithoutReplacingANewVisitDraft() async throws {
        let transport = ForecastTransport()
        let clock = ForecastTestClock()
        let life = ResearchLifeScenarioModel(service: client(transport), now: { clock.read() }, newID: { "saved-id" })
        let center = NativeNoticeCenter(now: { clock.read() }, automaticExpiry: false)
        life.attachNotices(center)
        await life.loadSaved()
        life.draft = validDraft()
        await life.saveDraft()
        let previous = try #require(await transport.writes.last)
        await life.deleteDraft()
        life.didDisappear()
        life.beginVisit()
        life.draft.name = "New visit draft"
        #expect(await center.consumeUndo())
        #expect(await transport.writes.last?["value"] == previous["value"])
        #expect(life.draft.name == "New visit draft")
        #expect(await center.consumeUndo() == false)
    }

    @Test func comparisonEditWhileRunningHidesLateResultAndServerMismatchProducesItsError() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport))
        life.draft = validDraft()
        await transport.pauseNextForecast()
        let run = Task { await life.run() }
        await transport.waitForPause()
        life.draft.name = "Changed while running"
        await transport.release()
        await run.value
        #expect(life.comparison == nil && !life.running && life.error == nil)
        await transport.mismatched(true)
        await life.run()
        #expect(life.comparison == nil && life.error == "research.lifeScenario.inputsChanged")
    }
    @Test func unavailablePairsRetainRawReasonsAndNeverInventComparisonMoney() async throws {
        let transport = ForecastTransport()
        await transport.unavailable(true)
        let life = ResearchLifeScenarioModel(service: client(transport))
        life.draft = validDraft()
        await life.run()
        let result = try #require(life.comparison)
        #expect(!result.available && result.medianGap == nil && result.baseline.reason == "no_holdings")
        #expect(result.baseline.projected == nil && result.interrupted.netInvested == nil)
    }
    @Test func changedDraftDuringServerPreparationNeverStartsObsoleteSimulationRequests() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport))
        life.draft = validDraft()
        await transport.pauseNextPreparation()
        let run = Task { await life.run() }
        await transport.waitForPause()
        life.draft.name = "New preparation context"
        await transport.release()
        await run.value
        #expect(await transport.forecasts.isEmpty)
        #expect(life.comparison == nil && !life.running && life.error == nil)
    }
    @Test func lateSavedListReadCannotRestoreAnAcknowledgedDeletion() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport))
        await life.loadSaved()
        life.draft = validDraft()
        await life.saveDraft()
        await transport.pauseNextRead()
        let stale = Task { await life.loadSaved(force: true) }
        await transport.waitForPause()
        await life.deleteDraft()
        #expect(life.scenarios.isEmpty && !life.loadingSaved)
        await transport.release()
        await stale.value
        #expect(life.scenarios.isEmpty && life.draft.id == nil)
    }
    @Test func lateSettingsReceiptAdvancesCASWithoutRestoringAnExitedDraft() async throws {
        let transport = ForecastTransport()
        let life = ResearchLifeScenarioModel(service: client(transport), newID: { "receipt-id" })
        await life.loadSaved()
        life.draft = validDraft()
        await transport.pauseNextWrite()
        let save = Task { await life.saveDraft() }
        await transport.waitForPause()
        life.didDisappear()
        life.beginVisit()
        await transport.release()
        await save.value
        for _ in 0..<200 {
            if life.scenarios.count == 1 { break }
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(life.scenarios.count == 1 && life.draft.name.isEmpty)
        life.selectSaved("receipt-id")
        life.draft.name = "New visit edit"
        await life.saveDraft()
        #expect(await transport.writes.count == 2)
        #expect(
            await transport.writes.last?["expected"]?["value"]?.arrayValue?.first?["name"] == .string("Interruption"))
    }
    @Test func coordinatorRepeatedLoadsPreserveDraftsAndRealExitResetsThem() async throws {
        let screens = ResearchForecastScreens(service: client(ForecastTransport()))
        await screens.didAppear()
        screens.model.contributionText = "42"
        screens.life.draft = validDraft()
        await screens.didAppear()
        #expect(screens.model.contributionText == "42" && screens.life.draft.name == "Interruption")
        screens.configure(settings: .defaults)
        #expect(screens.life.draft.name == "Interruption")
        screens.didDisappear()
        #expect(screens.model.contributionText.isEmpty && screens.life.draft.name.isEmpty)
    }
    private func client(_ transport: ForecastTransport) -> APIClient {
        .init(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
    }
    private func validDraft() -> ResearchLifeScenarioDraft {
        var draft = ResearchLifeScenarioDraft()
        draft.name = "Interruption"
        draft.monthlySurplus = "1000"
        draft.monthlyIncomeLoss = "700"
        draft.monthlyContribution = "600"
        return draft
    }
}

private func forecastFixture(interrupted: Bool = false, horizon: TaxValue = .number(60)) -> TaxValue {
    let bands: [String: TaxValue] = [
        "p10": .number(8000), "p25": .number(9000), "p50": .number(interrupted ? 9700 : 10000), "p75": .number(11000),
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
    private(set) var writes: [TaxValue] = []
    private var stored = TaxValue.array([])
    private var exists = false
    private var readFailure = false
    private var writeFailure = false
    private var mismatch = false
    private var missing = false
    private var pause = false
    private var pausePreparation = false
    private var pauseRead = false
    private var pauseWrite = false
    private var paused: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func failReads(_ value: Bool) { readFailure = value }
    func rejectWrites(_ value: Bool) { writeFailure = value }
    func mismatched(_ value: Bool) { mismatch = value }
    func unavailable(_ value: Bool) { missing = value }
    func pauseNextForecast() { pause = true }
    func pauseNextPreparation() { pausePreparation = true }
    func pauseNextRead() { pauseRead = true }
    func pauseNextWrite() { pauseWrite = true }
    func waitForPause() async { if paused == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        paused?.resume()
        paused = nil
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let output: TaxValue
        switch request.url.path {
        case "/api/settings/life_scenarios":
            let readSnapshot = stored
            let readExists = exists
            if request.method == .get {
                if readFailure { throw APIError.backendUnavailable }
                if pauseRead {
                    pauseRead = false
                    await withCheckedContinuation {
                        paused = $0
                        entered?.resume()
                        entered = nil
                    }
                }
            } else {
                let body = try JSONDecoder().decode(TaxValue.self, from: request.body ?? Data())
                writes.append(body)
                if writeFailure {
                    throw APIError.client(.init(status: 409, code: .conflict, message: "Setting changed"))
                }
                stored = body["value"] ?? .array([])
                exists = true
                if pauseWrite {
                    pauseWrite = false
                    await withCheckedContinuation {
                        paused = $0
                        entered?.resume()
                        entered = nil
                    }
                }
            }
            let responseValue = request.method == .get ? readSnapshot : stored
            let responseExists = request.method == .get ? readExists : exists
            var baseline: [String: TaxValue] = ["exists": .bool(responseExists)]
            if responseExists { baseline["value"] = responseValue }
            output = .object(["key": .string("life_scenarios"), "value": responseValue, "expected": .object(baseline)])
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
            output =
                missing
                ? .object(["available": .bool(false), "reason": .string("no_holdings")])
                : forecastFixture(
                    interrupted: input["monthly_contribution_schedule"] != nil,
                    horizon: input["horizon_months"] ?? .number(60))
        case "/api/research/presentation":
            let body = String(decoding: request.body ?? Data(), as: UTF8.self)
            guard let from = body.range(of: "\r\n\r\n"),
                let to = body.range(of: "\r\n--", range: from.upperBound..<body.endIndex)
            else { throw APIError.invalidRequest("Synthetic multipart") }
            let input = try JSONDecoder().decode(TaxValue.self, from: Data(body[from.upperBound..<to.lowerBound].utf8))
            if input["kind"] == .string("lifeScenarioPrepare") {
                if pausePreparation {
                    pausePreparation = false
                    await withCheckedContinuation {
                        paused = $0
                        entered?.resume()
                        entered = nil
                    }
                }
                var baseline = input["forecastInput"]?.objectValue ?? [:]
                baseline["monthlyContribution"] = input["scenario"]?["monthlyContribution"]
                baseline["targetValue"] = input["scenario"]?["goalValue"]
                baseline["goalMonth"] = input["goalMonth"]
                baseline["seed"] = .string("life-scenario:" + (input["scenario"]?["id"]?.stringValue ?? ""))
                var interrupted = baseline
                interrupted["monthlyContributionSchedule"] = .array([.number(300), .number(300), .number(300)])
                var result: [String: TaxValue] = [
                    "baselineInput": .object(baseline), "interruptedInput": .object(interrupted),
                    "reducedContribution": .number(300), "monthlyDeficit": .number(0),
                ]
                result["goalMonth"] = input["goalMonth"]
                output = .object(["kind": .string("lifeScenarioPrepare"), "result": .object(result)])
            } else {
                output = .object([
                    "kind": .string("lifeScenarioCompare"),
                    "result": .object([
                        "comparable": .bool(!mismatch), "available": .bool(!missing && !mismatch),
                        "medianGap": missing || mismatch ? .null : .number(-300),
                        "errorKey": mismatch ? .string("research.lifeScenario.inputsChanged") : .null,
                    ]),
                ])
            }
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
