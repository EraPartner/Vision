import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Portfolio Tax authoritative transport and structural settings")
struct PortfolioTaxDataTests {
    @Test func authoritativeTotalsAndDecimalSettingsAreNotRecomputed() throws {
        let value = try portfolioTaxFixture()
        #expect(value.totals.totalTaxes == Decimal(string: "123456789.123456789012345"))
        // These synthetic totals intentionally differ from component amounts. Native
        // display must use the authoritative fields rather than run tax arithmetic.
        #expect(value.totals.totalManualCosts == 917)
        #expect(value.totals.portfolioTaxesPlusPIT == 2468)
        #expect(value.dividend.dividendWhtReclaim == nil)
        #expect(value.records[0].value["2026:1"]?["future"] == .number(Decimal(string: "0.1234567890123456789")!))
        try value.validate(year: 2025, currency: "EUR")
    }
    @Test func settingsReplacementPreservesOtherYearsUnknownFieldsAndRawCAS() throws {
        let source = try portfolioTaxFixture()
        var settings = try PortfolioTaxSettingsDraft(records: source.records)
        var row = PortfolioTaxAdjustmentDraft(
            investment: source.summaries[0], year: 2026, values: settings, format: .eu)
        row.taxes = "7,123456789012345"
        row.fees = "invalid"
        row.etfStructure = .distributing
        row.reynders = .no
        row.interestPortion = "100"
        try settings.apply(rows: [row], year: 2026, format: .eu)
        let patch = settings.patch
        #expect(Set(patch.settings.keys) == ["portfolio_tax_adjustments_v1", "portfolio_tax_classifications_v1"])
        #expect(patch.expected[PortfolioTaxSettingsDraft.adjustmentsKey] == source.records[0].expected)
        #expect(settings.adjustments["2026:1"]?["taxes"] == .number(Decimal(string: "7.123456789012345")!))
        #expect(settings.adjustments["2026:1"]?["fees"] == .number(0))
        #expect(settings.adjustments["2026:1"]?["future"] == source.records[0].value["2026:1"]?["future"])
        #expect(settings.adjustments["2025:1"] == source.records[0].value["2025:1"])
        #expect(settings.adjustments["2026:99"] == source.records[0].value["2026:99"])
        #expect(settings.classifications["1"]?["future"] == .string("keep"))
        #expect(settings.classifications["1"]?["subjectToReynders"] == .bool(false))
        #expect(settings.classifications["1"]?["reyndersInterestPortion"] == nil)
        #expect(settings.classifications["99"] == source.records[1].value["99"])
    }
    @Test func zeroDefaultAndAutomaticClassificationsStripOnlyOwnedFields() throws {
        let source = try portfolioTaxFixture()
        var values = try PortfolioTaxSettingsDraft(records: source.records)
        var row = PortfolioTaxAdjustmentDraft(investment: source.summaries[0], year: 2026, values: values, format: .us)
        row.etfStructure = nil
        row.reynders = .auto
        row.interestPortion = "0"
        try values.apply(rows: [row], year: 2026, format: .us)
        #expect(values.classifications["1"] == .object(["future": .string("keep")]))
        row.interestPortion = "25"
        try values.apply(rows: [row], year: 2026, format: .us)
        #expect(values.classifications["1"]?["reyndersInterestPortion"] == .number(Decimal(string: "0.25")!))
    }
    @Test func legacyNumericStringsUseStorageNotationThenTheEditingLocale() throws {
        let source = try portfolioTaxFixture()
        var settings = try PortfolioTaxSettingsDraft(records: source.records)
        var amounts = settings.adjustments["2026:1"]!
        amounts["taxes"] = .string("7.123456789012345")
        amounts["fees"] = .string("12garbage")
        settings.adjustments["2026:1"] = amounts
        let row = PortfolioTaxAdjustmentDraft(
            investment: source.summaries[0], year: 2026, values: settings, format: .eu)
        #expect(row.taxes == "7,123456789012345" && row.fees.isEmpty)
    }
    @Test func incompleteOrDuplicateBaselinesCannotReachPersistence() throws {
        let source = try portfolioTaxFixture()
        #expect(throws: APIError.self) { try PortfolioTaxSettingsDraft(records: [source.records[0]]) }
        #expect(throws: APIError.self) { try PortfolioTaxSettingsDraft(records: source.records + [source.records[0]]) }
        let invalid = PortfolioTaxSetting(
            key: source.records[0].key, value: source.records[0].value,
            expected: .object(["exists": .bool(true)]))
        #expect(throws: APIError.self) { try PortfolioTaxSettingsDraft(records: [invalid, source.records[1]]) }
    }
    @Test func absentSettingsSeedEmptyEditsWithoutChangingTheAbsenceBaseline() throws {
        let records = [PortfolioTaxSettingsDraft.adjustmentsKey, PortfolioTaxSettingsDraft.classificationsKey].map {
            PortfolioTaxSetting(key: $0, value: .null, expected: .object(["exists": .bool(false)]))
        }
        var draft = try PortfolioTaxSettingsDraft(records: records)
        let source = try portfolioTaxFixture()
        var row = PortfolioTaxAdjustmentDraft(investment: source.summaries[0], year: 2026, values: draft, format: .us)
        #expect(row.taxes.isEmpty && row.fees.isEmpty && row.etfStructure == nil && row.reynders == .auto)
        row.taxes = "12.5"
        try draft.apply(rows: [row], year: 2026, format: .us)
        #expect(draft.patch.expected.values.allSatisfy { $0 == .object(["exists": .bool(false)]) })
        #expect(draft.adjustments["2026:1"]?["taxes"] == .number(Decimal(string: "12.5")!))
        #expect(draft.classifications == .object([:]))
        try source.validate(year: 2025, currency: "eur")
    }
    @Test func transportKeepsGeneratedPathQueryAtomicBodyAndDecimalAmounts() async throws {
        let transport = PortfolioTaxTestTransport()
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let value = try await client.portfolioTaxDashboard(year: 2025, currency: "EUR")
        var draft = try PortfolioTaxSettingsDraft(records: value.records)
        var row = PortfolioTaxAdjustmentDraft(investment: value.summaries[0], year: 2026, values: draft, format: .us)
        row.taxes = "0.1234567890123456789"
        try draft.apply(rows: [row], year: 2026, format: .us)
        try await client.savePortfolioTaxSettings(draft.patch)
        let requests = await transport.requests
        #expect(requests.map(\.url.path) == ["/api/belgian-tax/portfolio-dashboard", "/api/settings"])
        let query = URLComponents(url: requests[0].url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        #expect(
            query.contains(.init(name: "year", value: "2025")) && query.contains(.init(name: "currency", value: "EUR")))
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(requests[1].body))
        #expect(
            body["settings"]?[PortfolioTaxSettingsDraft.adjustmentsKey]?["2026:1"]?["taxes"]
                == .number(Decimal(string: "0.1234567890123456789")!))
        let baseline = try TaxValue(encoding: value.records[0].expected)
        #expect(body["expected"]?[PortfolioTaxSettingsDraft.adjustmentsKey] == baseline)
    }
    @Test func transportRejectsCurrencyMismatchAndPartialSaveAcknowledgement() async {
        let transport = PortfolioTaxTestTransport(wrongCurrency: true, savedCount: 1)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        await #expect(throws: APIError.self) { try await client.portfolioTaxDashboard(year: 2025, currency: "EUR") }
        await #expect(throws: APIError.self) {
            let draft = try PortfolioTaxSettingsDraft(records: portfolioTaxFixture().records)
            try await client.savePortfolioTaxSettings(draft.patch)
        }
    }
}

@MainActor @Suite("Portfolio Tax live editing and races")
struct PortfolioTaxModelTests {
    @Test func historicalDisplayEditsTheLiveYearAndCancelWritesNothing() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        await model.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(model.beginAdjustments(numberFormat: .eu))
        #expect(model.adjustmentYear == 2026 && model.dashboard?.year == 2025)
        #expect(model.draftRows.map(\.name) == ["Alpha ETF", "Zeta bond"])
        #expect(model.draftRows.first?.taxes == "2,5")
        model.updateDraft(id: 1) { $0.taxes = "100,25" }
        #expect(model.draftTotals.taxes == Decimal(string: "100.25"))
        #expect(model.closeAdjustments())
        #expect(await service.writes.isEmpty)
        #expect(model.beginAdjustments(numberFormat: .eu))
        #expect(model.draftRows.first?.taxes == "2,5")
    }
    @Test func invalidCollapsedInterestOpensAndFocusesWithoutSaving() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        await model.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(model.beginAdjustments(numberFormat: .us))
        model.updateDraft(id: 1) {
            $0.reynders = .yes
            $0.interestPortion = "100.5"
        }
        #expect(!(await model.saveAdjustments()))
        #expect(model.focusInvestmentID == 1 && model.draftRows.first?.treatmentExpanded == true)
        #expect(await service.writes.isEmpty)
        model.updateDraft(id: 1) { $0.interestPortion = "25" }
        #expect(await model.saveAdjustments())
        #expect(!model.isAdjustmentsPresented && model.notice?.key == "tax.manualAdjustmentsSaved")
    }
    @Test func conflictRetainsDraftAndOriginalCASDespiteAnExternalRead() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        await model.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(model.beginAdjustments(numberFormat: .eu))
        model.updateDraft(id: 1) { $0.taxes = "7,125" }
        let original = await service.records[0].expected
        await service.setFailure(true)
        #expect(!(await model.saveAdjustments()))
        await service.externalChange()
        await model.load(year: 2025, liveYear: 2026, currency: "EUR", force: true)
        #expect(model.isAdjustmentsPresented && model.draftRows.first?.taxes == "7,125")
        #expect(!(await model.saveAdjustments()))
        #expect(await service.writes.count == 2)
        #expect(await service.writes.allSatisfy { $0.expected[PortfolioTaxSettingsDraft.adjustmentsKey] == original })
    }
    @Test func lateYearAndCurrencyReadCannotReplaceTheSelectedDashboard() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        await service.pause("dashboard")
        let old = Task { await model.load(year: 2025, liveYear: 2026, currency: "EUR") }
        await service.waitForPause()
        await model.load(year: 2024, liveYear: 2026, currency: "USD")
        #expect(model.dashboard?.year == 2024 && model.dashboard?.currency == "USD")
        await service.release()
        await old.value
        #expect(model.dashboard?.year == 2024 && model.dashboard?.currency == "USD" && !model.isFetching)
    }
    @Test func lostAcknowledgementInvalidatesDependentsAndReopeningUsesTheCommittedBaseline() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        var notifications = 0
        model.didSave = { notifications += 1 }
        await model.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(model.beginAdjustments(numberFormat: .eu))
        model.updateDraft(id: 1) { $0.taxes = "42,5" }
        await service.loseNextAcknowledgement()
        #expect(!(await model.saveAdjustments()))
        #expect(notifications == 1 && model.isAdjustmentsPresented)
        #expect(center.entries.last?.notice.key == "tax.manualAdjustmentsSaveFailed")
        #expect(model.draftRows.first?.taxes == "42,5")
        let committed = await service.records[0].expected
        #expect(model.closeAdjustments() && model.beginAdjustments(numberFormat: .eu))
        #expect(model.draftRows.first?.taxes == "42,5")
        #expect(await model.saveAdjustments())
        #expect(center.entries.map(\.notice.key) == ["tax.manualAdjustmentsSaveFailed", "tax.manualAdjustmentsSaved"])
        #expect(await service.writes.last?.expected[PortfolioTaxSettingsDraft.adjustmentsKey] == committed)
    }
    @Test func yearChangeDuringSaveKeepsTheWriteYearAndRefreshesTheCurrentView() async throws {
        let service = try PortfolioTaxTestService()
        let model = PortfolioTaxModel(service: service)
        let center = NativeNoticeCenter(automaticExpiry: false)
        model.attachNotices(center)
        await model.load(year: 2025, liveYear: 2026, currency: "EUR")
        #expect(model.beginAdjustments(numberFormat: .eu))
        model.updateDraft(id: 1) { $0.taxes = "9,75" }
        await service.pause("save")
        let save = Task { await model.saveAdjustments() }
        await service.waitForPause()
        #expect(!model.closeAdjustments())
        model.updateDraft(id: 1) { $0.taxes = "999" }
        #expect(model.draftRows.first?.taxes == "9,75")
        await model.load(year: 2024, liveYear: 2026, currency: "USD")
        await service.release()
        #expect(await save.value)
        #expect(center.entries.last?.notice.key == "tax.manualAdjustmentsSaved")
        #expect(center.entries.last?.notice == model.notice)
        center.dismiss(try #require(center.entries.last?.id))
        #expect(model.notice == nil)
        #expect(model.dashboard?.year == 2024 && model.dashboard?.currency == "USD")
        let patch = try #require(await service.writes.last)
        #expect(
            patch.settings[PortfolioTaxSettingsDraft.adjustmentsKey]?["2026:1"]?["taxes"]
                == .number(Decimal(string: "9.75")!))
        #expect(model.settingsLoaded && model.beginAdjustments(numberFormat: .eu))
        #expect(model.draftRows.first?.taxes == "9,75")
    }
    @Test func widgetChangesPreserveUnknownsAndAnOldReadCannotUndoTheSave() async throws {
        let service = try PortfolioTaxTestService()
        let widgets = PortfolioTaxWidgetsModel(service: service)
        await widgets.load()
        let original = await service.widgetRecord.expected
        await service.pause("widgets")
        let read = Task { await widgets.load() }
        await service.waitForPause()
        await widgets.setVisible("summaryCards", false)
        await service.release()
        await read.value
        #expect(!widgets.isVisible("summaryCards"))
        #expect(await service.widgetWrites.first?.expected == original)
        #expect(widgets.visibility.json["otherPage"]?["secretFuture"] == .bool(false))
        #expect(widgets.visibility.json["portfolioTax"]?["futureWidget"] == .bool(false))
        await widgets.setAll(false)
        #expect(PortfolioTaxWidgetsModel.definitions.allSatisfy { !widgets.isVisible($0.id) })
        await widgets.reset()
        #expect(PortfolioTaxWidgetsModel.definitions.allSatisfy { widgets.isVisible($0.id) })
        #expect(widgets.visibility.json["portfolioTax"]?["futureWidget"] == .bool(false))
    }
}

private func portfolioTaxFixture(year: Int = 2025, currency: String = "EUR", records: [PortfolioTaxSetting]? = nil)
    throws -> PortfolioTaxDashboard
{
    let raw = #"""
        {"year":2025,"currency":"EUR","isEmpty":false,"hasProfile":true,"hasInKindIncomeUnclassified":true,
        "totals":{"totalTaxes":123456789.123456789012345,"totalFees":2,"totalTaxesAndFees":3,"totalRecordedTaxes":4,"totalRecordedFees":5,"totalManualTaxes":6,"totalManualFees":7,"totalManualCosts":917,"totalRealizedGain":8,"totalUnrealizedGain":9,"effectiveTaxRate":10,"totalPIT":500,"portfolioTaxesPlusPIT":2468},
        "taxBreakdown":[{"nameKey":"tax.transactionTax","value":1}],"feeBreakdown":[],"taxByAssetClass":[{"assetClass":"etf","taxes":1,"fees":2,"total":3}],
        "investmentBreakdown":[{"id":1,"name":"Alpha ETF","symbol":"A","assetClass":"etf","recordedTaxes":1,"recordedFees":2,"manualTaxes":3,"manualFees":4,"taxes":5,"fees":6,"total":11,"realizedGain":789.123456789012345,"currency":"EUR"}],
        "yearlyCostTrend":[{"period":"2025-01","taxes":1,"fees":2}],
        "dividend":{"totalDividendIncome":10,"grossDividendWht":3,"dividendWhtReclaim":null,"dividendWhtNetCost":null,"unknownDividendConventionCount":1,"dividendExemption":859},
        "estimates":{"tobRecorded":1,"tobAutoEstimate":2,"tacrEstimate":3,"reyndersEstimate":4,"cgtEstimate":5},
        "taxTable":{"securitiesAccountTaxRate":0.0015,"capitalGainsTaxRate":0.1,"reyndersTaxRate":0.3,"dividendWHTRate":0.3,"securitiesAccountTaxThreshold":1000000,"badgePercent":{"securitiesAccountTaxRate":0.15,"capitalGainsTaxRate":10,"reyndersTaxRate":30,"dividendWHTRate":30}},
        "summaries":[{"id":1,"name":"Alpha ETF","symbol":"A","assetClass":"etf","currency":"USD"},{"id":2,"name":"Zeta bond","assetClass":"bond","currency":"EUR"}],
        "records":[{"key":"portfolio_tax_adjustments_v1","value":{"2026:1":{"taxes":2.5,"fees":1,"future":0.1234567890123456789},"2025:1":{"taxes":8,"fees":9},"2026:99":{"taxes":88,"fees":99},"future":{"value":"keep"}},"expected":{"exists":true,"value":{"syntheticCAS":"amounts-first"}}},
        {"key":"portfolio_tax_classifications_v1","value":{"1":{"etfStructure":"accumulating","subjectToReynders":true,"reyndersInterestPortion":0.5,"future":"keep"},"99":{"subjectToReynders":false}},"expected":{"exists":false}}]}
        """#
    var value = try JSONDecoder().decode(TaxValue.self, from: Data(raw.utf8))
    value["year"] = .number(Decimal(year))
    value["currency"] = .string(currency)
    var investments = value["investmentBreakdown"]!.arrayValue!
    investments[0]["currency"] = .string(currency)
    value["investmentBreakdown"] = .array(investments)
    if let records { value["records"] = try TaxValue(encoding: records) }
    return try value.decode(PortfolioTaxDashboard.self)
}

private actor PortfolioTaxTestTransport: APITransport {
    var requests: [APIRequest] = []
    let wrongCurrency: Bool
    let savedCount: Int
    init(wrongCurrency: Bool = false, savedCount: Int = 2) {
        self.wrongCurrency = wrongCurrency
        self.savedCount = savedCount
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let data: TaxValue
        if request.url.path == "/api/settings" {
            data = .object(["saved": .number(Decimal(savedCount))])
        } else {
            data = try TaxValue(encoding: portfolioTaxFixture(currency: wrongCurrency ? "USD" : "EUR"))
        }
        return APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
}
private actor PortfolioTaxTestService: PortfolioTaxService {
    var records: [PortfolioTaxSetting]
    var writes: [PortfolioTaxSettingsPatch] = []
    var widgetRecord: OpenAPI.Setting
    var widgetWrites: [(value: JSONValue, expected: JSONValue)] = []
    private var failure = false
    private var lostAcknowledgement = false
    private var paused: String?
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    init() throws {
        records = try portfolioTaxFixture().records
        let value: JSONValue = .object([
            "portfolioTax": .object(["futureWidget": .bool(false)]),
            "otherPage": .object(["secretFuture": .bool(false)]),
        ])
        widgetRecord = .init(
            key: "widget_visibility", value: value, expected: .object(["exists": .bool(true), "value": value]))
    }
    func pause(_ operation: String) { paused = operation }
    func waitForPause() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        held?.resume()
        held = nil
    }
    func setFailure(_ failure: Bool) { self.failure = failure }
    func loseNextAcknowledgement() { lostAcknowledgement = true }
    private func wait(_ operation: String) async {
        guard paused == operation else { return }
        paused = nil
        await withCheckedContinuation {
            held = $0
            entered?.resume()
            entered = nil
        }
    }
    func externalChange() {
        records[0] = .init(
            key: records[0].key, value: records[0].value,
            expected: .object(["exists": .bool(true), "value": .string("changed")]))
    }
    func portfolioTaxDashboard(year: Int, currency: String) async throws -> PortfolioTaxDashboard {
        let value = try portfolioTaxFixture(year: year, currency: currency, records: records)
        await wait("dashboard")
        return value
    }
    func savePortfolioTaxSettings(_ patch: PortfolioTaxSettingsPatch) async throws {
        writes.append(patch)
        await wait("save")
        if failure { throw APIError.invalidRequest("Synthetic CAS conflict") }
        records = try records.map { record in
            let value = patch.settings[record.key]!
            let raw = try JSONDecoder().decode(JSONValue.self, from: APIBody.encode(value))
            return .init(key: record.key, value: value, expected: .object(["exists": .bool(true), "value": raw]))
        }
        if lostAcknowledgement {
            lostAcknowledgement = false
            throw APIError.invalidRequest("Synthetic lost write acknowledgement")
        }
    }
    func portfolioTaxWidgetSetting() async throws -> OpenAPI.Setting {
        let value = widgetRecord
        await wait("widgets")
        return value
    }
    func savePortfolioTaxWidgets(value: JSONValue, expected: JSONValue) async throws -> OpenAPI.Setting {
        widgetWrites.append((value, expected))
        if failure { throw APIError.invalidRequest("Synthetic widget CAS conflict") }
        widgetRecord = .init(
            key: "widget_visibility", value: value, expected: .object(["exists": .bool(true), "value": value]))
        return widgetRecord
    }
}
