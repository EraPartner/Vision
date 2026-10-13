import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Rebalance shareable draft")
struct RebalanceURLTests {
    @Test func repeatedTargetsBlankCapAndUnfinishedFieldsSurviveRoundTrip() throws {
        let route = try #require(
            NativeRoute("/portfolio/rebalance?source=custom&target=stocks%3A&target=%3A7%2C5&name=My+mix&cap=&keep=yes")
        )
        let draft = RebalanceURLState.parse(route)
        #expect(draft.rows == [.init(sleeve: "stocks", pct: ""), .init(sleeve: "", pct: "7,5")])
        #expect(draft.capEnabled && draft.cap.isEmpty)
        #expect(draft.name == "My mix")
        let written = RebalanceURLState.write(draft, preserving: route)
        #expect(written.value("keep") == "yes")
        #expect(RebalanceURLState.parse(written) == draft)
    }
    @Test func switchingToDefaultPresetRemovesOnlyOwnedParameters() throws {
        let route = try #require(
            NativeRoute("/portfolio/rebalance?source=custom&target=stocks%3A30&name=Draft&cap=200&keep=x&keep=y"))
        let written = RebalanceURLState.write(.defaults, preserving: route)
        #expect(written.string == "/portfolio/rebalance?keep=x&keep=y")
        #expect(RebalanceURLState.parse(written) == .defaults)
    }
    @Test func invalidSourcesUnknownSleevesAndBoundedStringsMatchTheWebCodec() {
        let values = [
            URLQueryItem(name: "source", value: "model:unknown"), .init(name: "target", value: "other:20"),
            .init(name: "target", value: "stocks:" + String(repeating: "1", count: 100)),
            .init(name: "name", value: String(repeating: "😀", count: 80)),
            .init(name: "cap", value: String(repeating: "1", count: 100)),
        ]
        let draft = RebalanceURLState.parse(NativeRoute(path: "/portfolio/rebalance", query: values))
        #expect(draft.source == "model:sixty_forty")
        #expect(draft.rows.count == 1 && draft.rows[0].pct.count == 32)
        #expect(draft.name.utf16.count == 80)
        #expect(draft.cap.count == 32)
        let tooLong = NativeRoute(
            path: "/portfolio/rebalance",
            query: [.init(name: "source", value: "plan:" + String(repeating: "a", count: 129))])
        #expect(RebalanceURLState.parse(tooLong).source == "model:sixty_forty")
    }
    @Test func onlyTheFirstEightTargetParametersAreConsidered() {
        let targets = (0..<10).map { URLQueryItem(name: "target", value: "stocks:\($0)") }
        let draft = RebalanceURLState.parse(NativeRoute(path: "/portfolio/rebalance", query: targets))
        #expect(draft.rows.count == 8 && draft.rows.last?.pct == "7")
    }
}

@Suite("Rebalance typed wire and form inputs")
struct RebalanceDataTests {
    @Test func positiveRatiosAggregateDuplicateSleevesWithoutClientNormalization() {
        let rows: [RebalanceDraftRow] = [
            .init(sleeve: "stocks", pct: "20"), .init(sleeve: "stocks", pct: "30"),
            .init(sleeve: "gold", pct: "7,5"), .init(sleeve: "bonds", pct: "invalid"),
            .init(sleeve: "crypto", pct: "-20"), .init(sleeve: "", pct: "90"),
        ]
        #expect(
            RebalanceForm.weights(rows, format: .eu) == [
                "stocks": Decimal(string: "0.5")!, "gold": Decimal(string: "0.075")!,
            ])
        #expect(RebalanceForm.cap("bad", available: 1000, format: .eu) == nil)
        #expect(RebalanceForm.cap("", available: 1000, format: .eu) == nil)
        #expect(RebalanceForm.cap("-10", available: 1000, format: .eu) == 0)
        #expect(RebalanceForm.cap("2.500", available: 1000, format: .eu) == 1000)
    }
    @Test func presetsAndCurrentMixRetainFractionalPercentages() {
        let allWeather = RebalanceForm.rows(RebalancePreset.allWeather.weights, format: .eu)
        #expect(allWeather.first { $0.sleeve == "gold" }?.pct == "7,5")
        #expect(RebalanceForm.currentMix([:], format: .us) == RebalanceURLDraft.defaults.rows)
        #expect(
            RebalanceForm.currentMix(["stocks": 250, "bonds": 750], format: .us).first { $0.sleeve == "stocks" }?.pct
                == "25")
    }
    @Test func resultAmountsDecodeDirectlyAsDecimalAndRowsIncludeUnlabelledSleeves() throws {
        let data = try JSONDecoder().decode(RebalanceResult.self, from: Data(rebalanceWireFixture.utf8))
        #expect(data.actualValues["stocks"] == Decimal(string: "123456789.123456789"))
        #expect(data.deployment["stocks"] == Decimal(string: "111.123456789012345"))
        #expect(data.sleeves == ["bonds", "other", "stocks"])
        #expect(data.cashAccounts.first?.balanceCurrency == "EUR")
        #expect(data.cashAccounts.first?.accountCurrency == "USD")
    }
    @Test func persistedNumericStringsAndUnknownMetadataSurviveAnUnrelatedSave() throws {
        let raw = Data(
            #"{"id":"legacy","name":"Legacy","targetWeights":{"stocks":"0.6","bonds":0.4},"cashCap":"12.5","future":{"revision":2}}"#
                .utf8)
        let plan = try JSONDecoder().decode(RebalancePlan.self, from: raw)
        #expect(plan.targetWeights["stocks"] == Decimal(string: "0.6"))
        #expect(plan.cashCap == Decimal(string: "12.5"))
        let encoded = try JSONDecoder().decode(TaxValue.self, from: APIBody.encode(plan))
        #expect(encoded["targetWeights"]?["stocks"] == .string("0.6"))
        #expect(encoded["future"]?["revision"] == .number(2))
    }
    @Test func APIRequestsUseGeneratedEndpointsExactCapsAndCompleteCASBaselines() async throws {
        let transport = RebalanceFixtureTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let cap = Decimal(string: "501.123456789012345")!
        let result = try await client.rebalance(
            .init(currency: "EUR", targetWeights: ["stocks": Decimal(string: "0.2")!], availableCash: cap))
        #expect(result.deployment["stocks"] == Decimal(string: "111.123456789012345"))
        let cash = try await client.rebalanceCash(currency: "EUR", reserveFloor: Decimal(string: "77.001")!)
        #expect(cash.candidateCashCap == Decimal(string: "600.123456789012345"))
        let baseline: JSONValue = .object(["exists": .bool(false)])
        _ = try await client.saveRebalancePlans(
            [.init(id: "p", name: "Plan", targetWeights: ["stocks": Decimal(string: "0.123456789012345")!])],
            expected: baseline)
        let requests = await transport.requests
        #expect(
            requests.map(\.url.path) == [
                "/api/cross-workspace/rebalance", "/api/cross-workspace/commitment-aware-cash",
                "/api/settings/rebalance_plans",
            ])
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(requests[0].body))
        #expect(body["availableCash"] == .number(cap))
        #expect(body["model"] == nil)
        let settingBody = try JSONDecoder().decode(TaxValue.self, from: #require(requests[2].body))
        #expect(settingBody["expected"] == .object(["exists": .bool(false)]))
        #expect(
            settingBody["value"]?.arrayValue?.first?["targetWeights"]?["stocks"]
                == .number(Decimal(string: "0.123456789012345")!))
    }
    @Test func incompleteResultIsAContractFailureRatherThanAnEmptyDeployment() async {
        let transport = RebalanceFixtureTransport(incomplete: true)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        do {
            _ = try await client.rebalance(.init(currency: "EUR", model: .sixtyForty))
            Issue.record("Incomplete rebalance result must fail")
        } catch let error as APIError {
            guard case .contract = error else {
                Issue.record("Expected contract error")
                return
            }
        } catch { Issue.record("Expected APIError.contract") }
    }
}

@MainActor
@Suite("Rebalance model persistence and request state")
struct RebalanceModelTests {
    @Test func savedPlanDeepLinkSeedsOnceAndExplicitDraftWins() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(route: NativeRoute("/portfolio/rebalance?source=plan%3Afirst&keep=yes")!, settings: .defaults)
        #expect(model.draft.name == "First plan")
        #expect(model.draft.capEnabled && model.draft.cap == "250")
        #expect(model.route.value("keep") == "yes")
        let explicit = NativeRoute("/portfolio/rebalance?source=plan%3Afirst&target=gold%3A7%2C5&name=Draft&cap=")!
        await model.load(route: explicit, settings: .defaults)
        #expect(model.draft.name == "Draft" && model.draft.rows == [.init(sleeve: "gold", pct: "7,5")])
        #expect(model.draft.capEnabled && model.draft.cap.isEmpty)
        await model.load(
            route: NativeRoute("/portfolio/rebalance?source=plan%3Amissing&target=stocks%3A20")!, settings: .defaults)
        #expect(model.draft.source == "custom" && model.draft.rows[0].pct == "20")
    }
    @Test func computationCallsCashProjectionBeforeServerDeploymentAndKeepsUncappedBalance() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(
            route: NativeRoute("/portfolio/rebalance?source=custom&target=stocks%3A20&target=bonds%3A30&cap=400")!,
            settings: .defaults)
        model.setReserveFloor("77,001")
        await model.compute()
        let request = try #require(await service.requests.last)
        #expect(request.availableCash == 400)
        #expect(request.targetWeights == ["stocks": Decimal(string: "0.2")!, "bonds": Decimal(string: "0.3")!])
        #expect(await service.events.suffix(2) == ["cash", "compute"])
        #expect(model.availableCash == 1000 && model.result?.availableCash == 400)
        #expect(model.projection?.reserveFloor == Decimal(string: "77.001"))
    }
    @Test func invalidFloorCannotReachEitherFinancialOperationAndEditingClearsTheError() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(route: NativeRoute(path: "/portfolio/rebalance"), settings: .defaults)
        let count = await service.requests.count
        model.setReserveFloor("-1")
        await model.compute()
        #expect(model.errorKey == "rebalance.commitment.invalidFloor")
        #expect(await service.requests.count == count)
        model.setReserveFloor("0")
        #expect(model.errorKey == nil)
        await model.compute()
        #expect(model.result != nil)
        #expect(await service.requests.last?.availableCash == 500)
        #expect(await service.requests.last?.model == "sixty_forty")
        #expect(await service.requests.last?.targetWeights == nil)
    }
    @Test func editedWeightsInvalidateInFlightResultsButRenamingDoesNot() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(
            route: NativeRoute("/portfolio/rebalance?source=custom&target=stocks%3A60&name=Original")!,
            settings: .defaults)
        await model.compute()
        model.updateDraft { $0.name = "Renamed" }
        #expect(model.result != nil)
        await service.pauseCompute()
        let pending = Task { await model.compute() }
        await service.waitForPause()
        model.updateRow(0, pct: "25")
        #expect(model.result == nil && model.projection == nil && !model.isComputing)
        await service.release()
        await pending.value
        #expect(model.result == nil)
    }
    @Test func saveKeepsOriginalCASAndUnknownFieldsAndFailureRetainsTheDraft() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(route: NativeRoute("/portfolio/rebalance?source=plan%3Afirst")!, settings: .defaults)
        let baseline = await service.record.expected
        model.updateDraft { $0.name = "Updated" }
        await service.setFailure(true)
        await model.savePlan()
        #expect(model.errorKey == "rebalance.plan.saveFailed")
        #expect(model.draft.name == "Updated" && model.plans.first?.name == "First plan")
        await service.setFailure(false)
        await model.savePlan()
        let writes = await service.writes
        #expect(writes.count == 2 && writes.allSatisfy { $0.expected == baseline })
        #expect(writes.last?.plans.first?.storedValue["future"] == .string("keep"))
        #expect(writes.last?.plans.last?.id == "other")
        #expect(model.noticeKey == "rebalance.plan.updated")
    }
    @Test func deletingRequiresConfirmationAndResetsOnlyOwnedURLState() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(route: NativeRoute("/portfolio/rebalance?source=plan%3Afirst&keep=yes")!, settings: .defaults)
        model.requestDelete()
        model.deletingPlan = nil
        #expect(await service.writes.isEmpty)
        model.requestDelete()
        await model.deletePlan()
        #expect(model.plans.map(\.id) == ["other"])
        #expect(model.draft.source == "model:sixty_forty")
        #expect(model.route.value("keep") == "yes")
        #expect(model.noticeKey == "rebalance.plan.deleted")
    }
    @Test func stalePlanReadCannotReplaceAnAcknowledgedWrite() async throws {
        let service = try RebalanceFixtureService()
        let model = RebalanceModel(service: service)
        await model.load(route: NativeRoute("/portfolio/rebalance?source=plan%3Afirst")!, settings: .defaults)
        await service.pausePlans()
        let read = Task { await model.load(route: model.route, settings: .defaults, force: true) }
        await service.waitForPause()
        model.updateDraft { $0.name = "New name" }
        await model.savePlan()
        await service.release()
        await read.value
        #expect(model.plans.first?.name == "New name")
        #expect(model.draft.name == "New name")
    }
    @Test func lateInputResponseCannotRestoreThePreviousCurrency() async throws {
        let service = try RebalanceFixtureService()
        await service.pauseInputs()
        let model = RebalanceModel(service: service)
        let old = Task { await model.load(route: NativeRoute(path: "/portfolio/rebalance"), settings: .defaults) }
        await service.waitForPause()
        await model.load(route: NativeRoute(path: "/portfolio/rebalance"), settings: .init(defaultCurrency: "USD"))
        #expect(model.inputs?.currency == "USD")
        await service.release()
        await old.value
        #expect(model.inputs?.currency == "USD")
        #expect(!model.isLoadingInputs)
    }
}

private let rebalanceWireFixture =
    #"{"currency":"EUR","targetWeights":{"stocks":0.6,"bonds":0.4},"actualValues":{"stocks":123456789.123456789,"other":20},"availableCash":1000,"cashAccounts":[{"id":1,"name":"Synthetic USD account","accountCurrency":"USD","balance":123.45,"balanceCurrency":"EUR"}],"deployment":{"stocks":111.123456789012345}}"#
private let rebalanceCashWireFixture =
    #"{"currency":"EUR","today":"2026-10-13","horizonEnd":"2027-01-11","horizonDays":90,"currentCash":1000,"reserveFloor":77.001,"minimumProjectedBalance":700,"minimumDate":"2026-11-01","candidateCashCap":600.123456789012345,"occurrenceCount":5,"assumptions":{"plannedOnly":true,"excludesStatisticalForecast":true,"excludesFutureIncome":true,"excludesUnplannedExpenses":true,"currencyConversionAtRecentRates":true}}"#

private actor RebalanceFixtureTransport: APITransport {
    var requests: [APIRequest] = []
    let incomplete: Bool
    init(incomplete: Bool = false) { self.incomplete = incomplete }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let data: String
        if request.url.path.contains("commitment-aware-cash") {
            data = rebalanceCashWireFixture
        } else if request.url.path.contains("settings") {
            let body = try JSONDecoder().decode(TaxValue.self, from: request.body!)
            let value = body["value"]!
            let setting: TaxValue = .object([
                "key": .string("rebalance_plans"), "value": value,
                "expected": .object(["exists": .bool(true), "value": value]),
            ])
            data = String(decoding: try APIBody.encode(setting), as: UTF8.self)
        } else {
            data = incomplete ? "{}" : rebalanceWireFixture
        }
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(data)}".utf8))
    }
}
private actor RebalanceFixtureService: RebalanceService {
    struct Write: Sendable {
        let plans: [RebalancePlan]
        let expected: JSONValue
    }
    var record: OpenAPI.Setting
    var requests: [RebalanceRequest] = []
    var events: [String] = []
    var writes: [Write] = []
    private var fails = false
    private var pause: String?
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    init() throws {
        let value: JSONValue = .array([
            .object([
                "id": .string("first"), "name": .string("First plan"),
                "targetWeights": .object(["stocks": .double(0.6), "bonds": .double(0.4)]), "cashCap": .int(250),
                "future": .string("keep"),
            ]),
            .object([
                "id": .string("other"), "name": .string("Other plan"), "targetWeights": .object(["gold": .int(1)]),
            ]),
        ])
        record = .init(
            key: "rebalance_plans", value: value, expected: .object(["exists": .bool(true), "value": value]))
    }
    func setFailure(_ value: Bool) { fails = value }
    func pauseCompute() { pause = "compute" }
    func pauseInputs() { pause = "inputs" }
    func pausePlans() { pause = "plans" }
    func waitForPause() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        held?.resume()
        held = nil
    }
    private func waitIfPaused(_ kind: String) async {
        if pause == kind {
            pause = nil
            await withCheckedContinuation {
                held = $0
                entered?.resume()
                entered = nil
            }
        }
    }
    func rebalance(_ request: RebalanceRequest) async throws -> RebalanceResult {
        requests.append(request)
        let kind = request.availableCash == nil ? "inputs" : "compute"
        events.append(kind)
        await waitIfPaused(kind)
        return .init(
            currency: request.currency,
            targetWeights: ["stocks": Decimal(string: "0.6")!, "bonds": Decimal(string: "0.4")!],
            actualValues: ["stocks": 250, "bonds": 750], availableCash: request.availableCash ?? 1000, cashAccounts: [],
            deployment: ["stocks": 200])
    }
    func rebalanceCash(currency: String, reserveFloor: Decimal) async throws -> RebalanceCashProjection {
        events.append("cash")
        let value = try JSONDecoder().decode(RebalanceCashProjection.self, from: Data(rebalanceCashWireFixture.utf8))
        return .init(
            currency: currency, today: value.today, horizonEnd: value.horizonEnd, horizonDays: 90, currentCash: 1000,
            reserveFloor: reserveFloor, minimumProjectedBalance: 700, minimumDate: value.minimumDate,
            candidateCashCap: 500, occurrenceCount: 5, assumptions: value.assumptions)
    }
    func rebalancePlans() async throws -> OpenAPI.Setting {
        events.append("plans")
        let value = record
        await waitIfPaused("plans")
        return value
    }
    func saveRebalancePlans(_ plans: [RebalancePlan], expected: JSONValue) async throws -> OpenAPI.Setting {
        writes.append(.init(plans: plans, expected: expected))
        if fails { throw APIError.network("Synthetic settings conflict") }
        let value = try JSONDecoder().decode(JSONValue.self, from: APIBody.encode(plans))
        record = .init(
            key: "rebalance_plans", value: value, expected: .object(["exists": .bool(true), "value": value]))
        return record
    }
}
