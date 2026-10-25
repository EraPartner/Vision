import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Tax profile structural edits")
struct TaxProfileDraftTests {
    @Test func partnerRemovalClearsReferencesAndRetainsUnknownFields() throws {
        var draft = TaxProfileDraft(value: try profileHousehold())
        draft.setHasPartner(true)
        draft.set(["dependents", "claimantPartnerId"], .string("B"))
        draft.set(["home", "mortgageCreditPartnerId"], .string("B"))
        draft.set(["home", "mortgageSharePartnerB"], .number(50))
        draft.set(["relationship", "deathYearElection"], .string("joint"))
        draft.addEvent()
        draft.setEventKind(index: 0, kind: "death")
        draft.setHasPartner(false)
        #expect(draft.partners.count == 1)
        #expect(draft.get(["dependents", "claimantPartnerId"]) == .string("A"))
        #expect(draft.get(["home", "mortgageCreditPartnerId"]) == .string("A"))
        #expect(draft.get(["home", "mortgageSharePartnerB"]) == nil)
        #expect(draft.get(["relationship", "events"]) == .array([]))
        #expect(draft.get(["relationship", "deathYearElection"]) == nil)
        #expect(draft.get(["futureField"]) == .string("preserve me"))
    }
    @Test func activityKindTransfersExactAmountAndPrunesUnusedChoices() throws {
        var draft = TaxProfileDraft(value: try profileHousehold())
        let amount = Decimal(string: "12345.67890123456789")!
        draft.set(["partners", "0", "activities", "0", "grossIncome"], .number(amount))
        draft.set(
            ["partners", "0", "professionalExpenses", "remuneration"],
            .object(["method": .string("actual"), "actualAmount": .number(100)]))
        draft.setActivityKind(partner: "A", index: 0, kind: "net_professional_amount")
        #expect(draft.get(["partners", "0", "activities", "0", "netProfessionalIncome"]) == .number(amount))
        #expect(draft.get(["partners", "0", "activities", "0", "grossIncome"]) == .number(0))
        #expect(draft.expenseCategories("A").isEmpty)
        #expect(draft.get(["partners", "0", "professionalExpenses"]) == .object([:]))
        draft.setActivityKind(partner: "A", index: 0, kind: "employee")
        #expect(draft.get(["partners", "0", "activities", "0", "grossIncome"]) == .number(amount))
        #expect(draft.get(["partners", "0", "activities", "0", "netProfessionalIncome"]) == nil)
        draft.removeActivity(partner: "A", index: 0)
        #expect(draft.get(["partners", "0", "activities"])?.arrayValue?.count == 1)
    }
    @Test func activityAndEventIdentifiersStayUnique() throws {
        var draft = TaxProfileDraft(value: try profileHousehold())
        draft.addActivity(partner: "A")
        draft.addActivity(partner: "A")
        draft.setHasPartner(true)
        let ids = draft.partners.flatMap { $0["activities"]?.arrayValue ?? [] }.compactMap { $0["id"]?.stringValue }
        #expect(Set(ids).count == ids.count)
        draft.addEvent()
        draft.addEvent()
        #expect(draft.get(["relationship", "events", "1", "id"]) == .string("evt_2"))
        #expect(draft.get(["relationship", "events", "0", "date"]) == .string("2024-01-01"))
    }
    @Test func incomeValidationMatchesTheWebRuleOrder() throws {
        var draft = TaxProfileDraft(value: try profileHousehold())
        let activity = ["partners", "0", "activities", "0"]
        draft.set(activity + ["grossIncome"], .number(0))
        draft.set(activity + ["startDate"], .string("2025-06-01"))
        draft.set(activity + ["endDate"], .string("2025-01-01"))
        draft.set(
            ["partners", "0", "professionalExpenses", "remuneration"],
            .object(["method": .string("actual"), "actualAmount": .number(0)]))
        #expect(draft.incomeErrorKey == "tax.profile.validation.grossIncomeRequired")
        draft.set(activity + ["grossIncome"], .number(1))
        #expect(draft.incomeErrorKey == "tax.profile.validation.actualExpensesRequired")
        draft.set(["partners", "0", "professionalExpenses", "remuneration", "actualAmount"], .number(1))
        #expect(draft.incomeErrorKey == "tax.profile.validation.activityDatesOrder")
        draft.set(activity + ["endDate"], nil)
        #expect(draft.incomeErrorKey == nil)
    }
    @Test func reducingDependentCountClampsDisabledCount() throws {
        var draft = TaxProfileDraft(value: try profileHousehold())
        draft.set(["dependents", "childrenDisabled"], .number(3))
        draft.setDependent("children", count: 1)
        #expect(draft.get(["dependents", "childrenDisabled"]) == .number(1))
    }
}

@MainActor
@Suite("Tax profile persistence")
struct TaxProfileModelTests {
    @Test func closeFlushesAllThreeKeysPreservingUnknownFieldsAndRawBaselines() async throws {
        let source = try profileOverview()
        let service = ProfileFixtureService(source: source)
        let overview = TaxOverviewModel(service: service)
        let model = TaxProfileModel(service: service, settings: service, overview: overview)
        model.begin(overview: source)
        let precise = Decimal(string: "200.123456789012345")!
        model.edit { $0.set(["partners", "0", "unionDues"], .number(precise)) }
        #expect(await model.close())
        #expect(!model.isPresented)
        let writes = await service.writes
        #expect(writes.count == 1)
        let patch = try #require(writes.first)
        #expect(patch.settings.count == 3)
        #expect(patch.settings[TaxYearMutation.householdKey]?["futureField"] == .string("preserve me"))
        #expect(
            patch.settings[TaxYearMutation.householdKey]?["partners"]?.arrayValue?.first?["futurePartnerField"]
                == .string("partner metadata"))
        #expect(
            patch.settings[TaxYearMutation.householdKey]?["partners"]?.arrayValue?.first?["activities"]?.arrayValue?
                .first?["futureActivityField"] == .string("activity metadata"))
        #expect(
            patch.settings[TaxYearMutation.householdKey]?["partners"]?.arrayValue?.first?["unionDues"]
                == .number(precise))
        #expect(patch.expected[TaxYearMutation.householdKey] == source.records.first?.expected)
        #expect(patch.settings[TaxYearMutation.householdKey]?["profileConfigured"] == .bool(false))
    }
    @Test func failedWriteKeepsDraftOpenAndDoesNotRebaseOntoNewerValues() async throws {
        let source = try profileOverview()
        let service = ProfileFixtureService(source: source)
        await service.setFailure(true)
        let model = TaxProfileModel(service: service, settings: service, overview: TaxOverviewModel(service: service))
        model.begin(overview: source)
        model.edit { $0.set(["partners", "0", "unionDues"], .number(500)) }
        #expect(!(await model.close()))
        #expect(model.isPresented && model.hasPendingChanges && model.error != nil)
        #expect(model.draft.get(["partners", "0", "unionDues"]) == .number(500))
        await service.setFailure(false)
        #expect(await model.close())
        let writes = await service.writes
        #expect(writes.count == 2)
        #expect(writes[0].expected == writes[1].expected)
    }
    @Test func filedAmendmentPinsYearAndPreservesFrozenFiguresWithBoundedHistory() async throws {
        let source = try profileOverview(year: 2024, filed: true)
        let service = ProfileFixtureService(source: source)
        let model = TaxProfileModel(service: service, settings: service, overview: TaxOverviewModel(service: service))
        model.begin(overview: source)
        model.edit { $0.set(["taxYear"], .number(2030)) }
        #expect(!model.hasPendingChanges)
        model.amendFiledYear()
        model.edit {
            $0.set(["taxYear"], .number(2030))
            $0.set(["partners", "0", "unionDues"], .number(20))
        }
        #expect(await model.close())
        let patch = try #require(await service.writes.first)
        let snapshot = patch.settings[TaxYearMutation.snapshotsKey]?["2024"]
        #expect(snapshot?["taxYear"] == .number(2024))
        let meta = patch.settings[TaxYearMutation.metadataKey]?["2024"]
        #expect(meta?["frozenCalculation"]?["totalPIT"] == .number(123))
        #expect(meta?["filing"]?["reference"] == .string("saved filing"))
        #expect(meta?["history"]?.arrayValue?.count == 200)
        #expect(meta?["history"]?.arrayValue?.last?["kind"] == .string("patched"))
        #expect(meta?["futureMeta"] == .string("retain"))
    }
    @Test func explicitEditRepairsOnlyInvalidKeyUsingTheOriginalBaseline() async throws {
        let source = try profileOverview(invalidLive: true)
        let service = ProfileFixtureService(source: source)
        let model = TaxProfileModel(service: service, settings: service, overview: TaxOverviewModel(service: service))
        model.begin(overview: source)
        #expect(model.isPresented)
        model.edit { $0.set(["partners", "0", "unionDues"], .number(20)) }
        #expect(await model.close())
        let patch = try #require(await service.writes.first)
        #expect(
            patch.expected[TaxYearMutation.householdKey]
                == .object(["exists": .bool(true), "value": .string("bad old value")]))
        #expect(patch.settings[TaxYearMutation.householdKey]?.objectValue != nil)
        #expect(
            patch.settings[TaxYearMutation.metadataKey]?["unrelatedYear"] == .object(["futureMeta": .string("retain")]))
    }
    @Test func forwardNavigationAndFinalSaveRequireTheIncomeStep() async throws {
        let source = try profileOverview()
        let service = ProfileFixtureService(source: source)
        let model = TaxProfileModel(service: service, settings: service, overview: TaxOverviewModel(service: service))
        model.begin(overview: source, initialStep: .region)
        model.edit { $0.set(["partners", "0", "activities", "0", "grossIncome"], .number(0)) }
        #expect(!(await model.save()))
        #expect(model.step == .income)
        model.go(to: .region)
        #expect(model.step == .income)
        model.go(to: .household)
        #expect(model.step == .household)
        model.edit { $0.set(["partners", "0", "activities", "0", "grossIncome"], .number(1)) }
        #expect(await model.save())
        #expect(await service.writes.last?.settings[TaxYearMutation.householdKey]?["profileConfigured"] == .bool(true))
    }
    @Test func editsDuringRefreshAreFlushedBeforeClosingAndUseAcknowledgedBaselines() async throws {
        let source = try profileOverview()
        let service = ProfileFixtureService(source: source)
        await service.pauseNextRead()
        let model = TaxProfileModel(service: service, settings: service, overview: TaxOverviewModel(service: service))
        model.begin(overview: source)
        model.edit { $0.set(["partners", "0", "unionDues"], .number(1)) }
        let closing = Task { await model.close() }
        await service.waitForRead()
        model.edit { $0.set(["partners", "0", "unionDues"], .number(2)) }
        await service.releaseRead()
        #expect(await closing.value)
        let writes = await service.writes
        #expect(writes.count == 2)
        let baseline = writes[1].expected[TaxYearMutation.householdKey]?["value"]
        #expect(baseline?["partners"]?.arrayValue?.first?["unionDues"] == .int(1))
        #expect(
            writes[1].settings[TaxYearMutation.householdKey]?["partners"]?.arrayValue?.first?["unionDues"] == .number(2)
        )
        #expect(!model.hasPendingChanges && !model.isPresented)
    }
    @Test func unfilingUsesExplicitEditorYearWithoutChangingTheMainViewedYear() async throws {
        let source = try profileOverview(year: 2024, filed: true)
        let service = ProfileFixtureService(source: source)
        let mainService = ProfileFixtureService(source: try profileOverview(year: 2023))
        let main = TaxOverviewModel(service: mainService)
        await main.load(year: 2023)
        let model = TaxProfileModel(service: service, settings: service, overview: main)
        model.begin(overview: source)
        let refreshed = try unfiledProfileOverview(source)
        model.didUnfile(overview: refreshed)
        #expect(!model.isFiled && !model.isLocked)
        #expect(main.overview?.year == 2023)
        #expect(model.year == 2024)
        model.edit { $0.set(["partners", "0", "unionDues"], .number(25)) }
        #expect(await model.close())
        let patch = try #require(await service.writes.first)
        #expect(
            patch.expected[TaxYearMutation.metadataKey]
                == refreshed.records.first { $0.key == TaxYearMutation.metadataKey }?.expected)
        #expect(patch.settings[TaxYearMutation.metadataKey]?["2024"]?["filing"] == nil)
        #expect(patch.settings[TaxYearMutation.metadataKey]?["2024"]?["frozenCalculation"]?["totalPIT"] == .number(123))
        #expect(main.overview?.year == 2023)
    }
}

private func unfiledProfileOverview(_ source: OpenAPI.BelgianTaxOverview) throws -> OpenAPI.BelgianTaxOverview {
    var root = try TaxValue(encoding: source)
    let rows = (root["records"]?.arrayValue ?? []).map { row -> TaxValue in
        guard row["key"]?.stringValue == TaxYearMutation.metadataKey, let value = row["value"] else { return row }
        var row = row
        var metadata = TaxProfileDraft(value: value)
        metadata.set([String(source.year), "filing"], nil)
        row["value"] = metadata.value
        row["expected"] = .object(["exists": .bool(true), "value": metadata.value])
        return row
    }
    root["records"] = .array(rows)
    return try root.decode(OpenAPI.BelgianTaxOverview.self)
}

private func profileHousehold(year: Int = 2025) throws -> TaxValue {
    try JSONDecoder().decode(
        TaxValue.self,
        from: Data(
            """
            {"version":2,"taxYear":\(year),"profileConfigured":false,"region":"flanders","communalSurchargePercent":7,
             "partners":[{"id":"A","isDisabled":false,"futurePartnerField":"partner metadata","activities":[{"id":"act_A_1","kind":"employee","grossIncome":50000,"futureActivityField":"activity metadata"}],
             "professionalExpenses":{},"unionDues":0,"otherTaxableIncome":0,"alimonyPaid":0,
             "reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":0,"charitableDonations":0,"childcareCosts":0,"medicalExpenses":0}}],
             "relationship":{"events":[]},"dependents":{"children":0,"otherPersons":0},"home":{"cadastralIncome":0,"mortgageInterestPaid":0},
             "futureField":"preserve me"}
            """.utf8))
}
private func profileOverview(year: Int = 2025, filed: Bool = false, invalidLive: Bool = false) throws
    -> OpenAPI.BelgianTaxOverview
{
    let live = try profileHousehold()
    let selected = try profileHousehold(year: year)
    let historical = year != 2025
    let snapshots: TaxValue = historical ? .object([String(year): selected]) : .object([:])
    var metadata: TaxValue = .object(["unrelatedYear": .object(["futureMeta": .string("retain")])])
    if filed {
        metadata[String(year)] = .object([
            "filing": .object(["reference": .string("saved filing")]),
            "frozenCalculation": .object(["totalPIT": .number(123)]), "futureMeta": .string("retain"),
            "history": .array(Array(repeating: .object(["kind": .string("created")]), count: 200)),
        ])
    }
    let settings = [
        TaxYearMutation.householdKey: invalidLive ? .string("bad old value") : live,
        TaxYearMutation.snapshotsKey: snapshots, TaxYearMutation.metadataKey: metadata,
    ]
    let records = try settings.keys.sorted().map { key -> OpenAPI.Setting in
        let value = try JSONDecoder().decode(JSONValue.self, from: APIBody.encode(settings[key]!))
        return .init(key: key, value: value, expected: .object(["exists": .bool(true), "value": value]))
    }.sorted { $0.key == TaxYearMutation.householdKey && $1.key != TaxYearMutation.householdKey }
    let totals = try JSONDecoder().decode(
        OpenAPI.BelgianTaxHouseholdTotals.self,
        from: Data(
            """
            {"grossIncome":50000,"employeeSocialSecurity":0,"professionalExpenses":0,"netProfessionalIncome":0,"taxableIncome":0,
            "federalPITBeforeExemption":0,"personalExemptionBenefit":0,"taxReductions":0,"federalPITAfterReductions":0,"communalSurcharge":0,
            "totalPIT":123,"specialSocialSecurityContribution":0,"propertyTaxEstimate":0,"totalTaxBurden":123,"netTakeHome":49877,
            "dividendWhtReclaim":0,"savingsInterestTax":0,"refundableChildCredit":0}
            """.utf8))
    let result = OpenAPI.BelgianTaxHouseholdTaxResult(
        engineVersion: 2, incomeYear: year,
        assessment: .init(mode: .single, reason: .onePartner, legalBasis: "fixture", partnerIds: [.a]), partners: [],
        quotient: .init(applied: false, transfer: 0, target: 0, cap: 0, benefit: 0),
        csss: .init(scale: .single, base: 0, total: 0),
        propertyTaxEstimate: 0, totals: totals, issues: [])
    return .init(
        year: year, liveYear: 2025, isHistorical: historical, hasSnapshot: historical, hasProfile: true,
        householdMigrationNeeded: false, snapshotsMigrationNeeded: false, storedValueInvalid: invalidLive,
        household: try selected.decode(OpenAPI.BelgianTaxHouseholdInput.self),
        liveHousehold: try live.decode(OpenAPI.BelgianTaxHouseholdInput.self),
        householdSnapshots: historical
            ? [String(year): try selected.decode(OpenAPI.BelgianTaxHouseholdInput.self)] : [:], snapshotMetas: [:],
        metadata: .object([:]),
        calculation: .init(totalPIT: 123), result: result, calculationSource: filed ? .frozen : .computed,
        householdResultSource: .computed,
        warnings: invalidLive
            ? [.init(key: TaxYearMutation.householdKey, kind: .invalidStored, issues: ["invalid fixture"])] : [],
        records: records)
}
private actor ProfileFixtureService: TaxComputationService, TaxSettingsService {
    let source: OpenAPI.BelgianTaxOverview
    var writes: [TaxSettingsPatch] = []
    var fails = false
    private var pause = false
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    init(source: OpenAPI.BelgianTaxOverview) { self.source = source }
    func setFailure(_ value: Bool) { fails = value }
    func pauseNextRead() { pause = true }
    func waitForRead() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func releaseRead() {
        held?.resume()
        held = nil
    }
    func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation {
        throw APIError.invalidRequest("Preview not used in this fixture")
    }
    func taxOverview(year: Int?) async throws -> OpenAPI.BelgianTaxOverview {
        if pause {
            pause = false
            await withCheckedContinuation {
                held = $0
                entered?.resume()
                entered = nil
            }
        }
        return source
    }
    func saveTaxSettings(_ patch: TaxSettingsPatch) async throws {
        writes.append(patch)
        if fails { throw APIError.invalidRequest("Synthetic CAS conflict") }
    }
}
