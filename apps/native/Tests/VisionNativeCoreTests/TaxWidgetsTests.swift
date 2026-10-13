import Foundation
import Testing

@testable import VisionNativeCore

@MainActor
@Suite("Native Tax widget preferences")
struct TaxWidgetsTests {
    @Test func defaultsAndWidgetKeysMatchTheWebTaxPage() {
        let model = TaxWidgetsModel(service: TaxWidgetFixtureService())
        #expect(TaxWidgetsModel.pageKey == "budgetTax")
        #expect(
            TaxWidgetsModel.definitions.map(\.id) == [
                "summaryCards", "trendStrip", "yearComparison",
                "incomeBreakdown", "pitBreakdown", "householdBreakdown", "taxRules", "yearlyOverview",
            ])
        #expect(TaxWidgetsModel.definitions.allSatisfy { model.isVisible($0.id) })
        #expect(!model.isVisible("unknown"))
    }

    @Test func writesWaitForAReadAndFailedInitialReadsDoNotInventABaseline() async {
        let service = TaxWidgetFixtureService()
        let model = TaxWidgetsModel(service: service)
        await model.setVisible("trendStrip", false)
        await model.setAll(false)
        await model.reset()
        #expect(await service.writes.isEmpty)
        await service.failReads()
        await model.load()
        #expect(!model.isLoaded)
        #expect(!model.isLoading)
        #expect(model.error != nil)
        await model.setVisible("trendStrip", false)
        #expect(await service.writes.isEmpty)
    }

    @Test func absentSettingUsesExistsFalseThenRefreshesTheSavedBaseline() async {
        let service = TaxWidgetFixtureService()
        let model = TaxWidgetsModel(service: service)
        await model.load()
        await model.setVisible("trendStrip", false)
        await model.setVisible("incomeBreakdown", false)
        let writes = await service.writes
        #expect(writes.count == 2)
        #expect(writes[0].expected == .object(["exists": .bool(false)]))
        #expect(writes[1].expected == .object(["exists": .bool(true), "value": writes[0].value]))
        #expect(!model.isVisible("trendStrip"))
        #expect(!model.isVisible("incomeBreakdown"))
    }

    @Test func malformedSettingNeverEnablesWritesWithAnInventedEmptyPageMap() async {
        let model = TaxWidgetsModel(service: TaxWidgetFixtureService(value: .array([])))
        await model.load()
        #expect(!model.isLoaded)
        #expect(!model.isLoading)
        #expect(model.error != nil)
    }

    @Test func revivedLegacyPreferencesKeepTheirRawStringConcurrencyToken() async {
        let value: JSONValue = .object(["budgetTax": .object(["trendStrip": .bool(false)])])
        let expected: JSONValue = .object([
            "exists": .bool(true), "value": .string("{\"budgetTax\":{\"trendStrip\":false}}"),
        ])
        let service = TaxWidgetFixtureService(value: value, expected: expected)
        let model = TaxWidgetsModel(service: service)
        await model.load()
        #expect(model.isLoaded)
        #expect(!model.isVisible("trendStrip"))
        await model.setVisible("incomeBreakdown", false)
        #expect(await service.writes.first?.expected == expected)
        #expect(model.error == nil)
    }

    @Test func individualAndBulkEditsPreserveOtherPagesAndFutureKeysAndResetClearsOnlyTaxPage() async {
        let raw: JSONValue = .object([
            "dashboard": .object(["hero": .bool(false)]),
            "budgetTax": .object(["futureWidget": .bool(false)]),
        ])
        let service = TaxWidgetFixtureService(value: raw)
        let model = TaxWidgetsModel(service: service)
        await model.load()
        await model.setVisible("trendStrip", false)
        #expect(model.visibility.pages["dashboard"] == raw["dashboard"])
        #expect(model.visibility.pages["budgetTax"]?["futureWidget"] == .bool(false))
        await model.setAll(false)
        #expect(model.visibility.pages["budgetTax"]?["futureWidget"] == .bool(false))
        #expect(TaxWidgetsModel.definitions.allSatisfy { !model.isVisible($0.id) })
        await model.reset()
        #expect(model.visibility.pages["budgetTax"] == nil)
        #expect(model.visibility.pages["dashboard"] == raw["dashboard"])
        #expect(TaxWidgetsModel.definitions.allSatisfy { model.isVisible($0.id) })
    }

    @Test func failedSaveRollsBackAndRetainsItsBaselineForRetry() async {
        let service = TaxWidgetFixtureService()
        let model = TaxWidgetsModel(service: service)
        await model.load()
        await service.failNextSave()
        await model.setVisible("trendStrip", false)
        #expect(model.isVisible("trendStrip"))
        #expect(!model.isSaving)
        #expect(model.error != nil)
        await model.setVisible("trendStrip", false)
        let writes = await service.writes
        #expect(writes[0].expected == writes[1].expected)
        #expect(!model.isVisible("trendStrip"))
        #expect(model.error == nil)
    }

    @Test func delayedReadCannotUndoACompletedToggleOrItsNewBaseline() async {
        let service = TaxWidgetFixtureService()
        let model = TaxWidgetsModel(service: service)
        await model.load()
        await service.delayNextRead()
        let staleRead = Task { await model.load() }
        await service.waitForBlockedRead()
        await model.setVisible("trendStrip", false)
        await service.releaseRead()
        await staleRead.value
        #expect(!model.isVisible("trendStrip"))
        #expect(!model.isLoading)
        await model.setVisible("incomeBreakdown", false)
        let writes = await service.writes
        #expect(writes[1].expected == .object(["exists": .bool(true), "value": writes[0].value]))
    }

    @Test func savingIsOptimisticAndAnOverlappingLoadCannotStartAStaleRead() async {
        let service = TaxWidgetFixtureService()
        let model = TaxWidgetsModel(service: service)
        await model.load()
        await service.delayNextSave()
        let save = Task { await model.setVisible("trendStrip", false) }
        await service.waitForBlockedSave()
        #expect(model.isSaving)
        #expect(!model.isVisible("trendStrip"))
        await model.load()
        await model.setVisible("incomeBreakdown", false)
        #expect(await service.readCount == 1)
        #expect(await service.writes.count == 1)
        await service.releaseSave()
        await save.value
        #expect(!model.isSaving)
        #expect(!model.isVisible("trendStrip"))
    }

    @Test func apiForwardsTheExactExpectedEnvelopeAndReadRoute() async throws {
        let transport = TaxWidgetTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let read = try await client.readTaxWidgets()
        let value: JSONValue = .object(["budgetTax": .object(["trendStrip": .bool(false)])])
        let saved = try await client.saveTaxWidgets(value: value, expected: read.expected)
        #expect(saved.expected == .object(["exists": .bool(true), "value": value]))
        let requests = await transport.requests
        #expect(requests.map(\.method) == [.get, .put])
        #expect(requests.allSatisfy { $0.url.path == "/api/settings/widget_visibility" })
        let body = try JSONDecoder().decode(JSONValue.self, from: #require(requests[1].body))
        #expect(body == .object(["value": value, "expected": .object(["exists": .bool(false)])]))
    }
}

private actor TaxWidgetFixtureService: TaxWidgetSettingsService {
    struct Write: Sendable {
        let value: JSONValue
        let expected: JSONValue
    }
    private var record: OpenAPI.Setting
    private var readsFail = false
    private var nextSaveFails = false
    private var shouldDelayRead = false
    private var shouldDelaySave = false
    private var blockedRead: CheckedContinuation<OpenAPI.Setting, Never>?
    private var blockedReadValue: OpenAPI.Setting?
    private var readWaiter: CheckedContinuation<Void, Never>?
    private var blockedSave: CheckedContinuation<Void, Never>?
    private var saveWaiter: CheckedContinuation<Void, Never>?
    private(set) var writes: [Write] = []
    private(set) var readCount = 0

    init(value: JSONValue? = nil, expected: JSONValue? = nil) {
        record = OpenAPI.Setting(
            key: "widget_visibility", value: value ?? .object([:]),
            expected: expected ?? value.map { .object(["exists": .bool(true), "value": $0]) }
                ?? .object(["exists": .bool(false)]))
    }
    func failReads() { readsFail = true }
    func failNextSave() { nextSaveFails = true }
    func delayNextRead() { shouldDelayRead = true }
    func delayNextSave() { shouldDelaySave = true }
    func readTaxWidgets() async throws -> OpenAPI.Setting {
        readCount += 1
        if readsFail { throw APIError.network("Read failed") }
        if shouldDelayRead {
            shouldDelayRead = false
            blockedReadValue = record
            return await withCheckedContinuation { continuation in
                blockedRead = continuation
                readWaiter?.resume()
                readWaiter = nil
            }
        }
        return record
    }
    func waitForBlockedRead() async {
        if blockedRead != nil { return }
        await withCheckedContinuation { readWaiter = $0 }
    }
    func releaseRead() {
        if let blockedRead, let blockedReadValue { blockedRead.resume(returning: blockedReadValue) }
        blockedRead = nil
        blockedReadValue = nil
    }
    func saveTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        writes.append(Write(value: value, expected: expected))
        if shouldDelaySave {
            shouldDelaySave = false
            await withCheckedContinuation { continuation in
                blockedSave = continuation
                saveWaiter?.resume()
                saveWaiter = nil
            }
        }
        if nextSaveFails {
            nextSaveFails = false
            throw APIError.client(APIClientError(status: 409, code: .conflict, message: "Setting changed"))
        }
        record = OpenAPI.Setting(
            key: "widget_visibility", value: value,
            expected: .object(["exists": .bool(true), "value": value]))
        return record
    }
    func waitForBlockedSave() async {
        if blockedSave != nil { return }
        await withCheckedContinuation { saveWaiter = $0 }
    }
    func releaseSave() {
        blockedSave?.resume()
        blockedSave = nil
    }
}

private actor TaxWidgetTransport: APITransport {
    private(set) var requests: [APIRequest] = []
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let record: OpenAPI.Setting
        if request.method == .get {
            record = OpenAPI.Setting(
                key: "widget_visibility", value: .object([:]),
                expected: .object(["exists": .bool(false)]))
        } else {
            let body = try JSONDecoder().decode(JSONValue.self, from: request.body ?? Data())
            let value = body["value"] ?? .null
            record = OpenAPI.Setting(
                key: "widget_visibility", value: value,
                expected: .object(["exists": .bool(true), "value": value]))
        }
        let json = String(decoding: try APIBody.encode(record), as: UTF8.self)
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(json)}".utf8))
    }
}
