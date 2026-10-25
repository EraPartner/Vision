import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native tax settings value and year mutations")
struct TaxYearMutationTests {
    @Test func editableJsonPreservesDecimalTypesAndUnknownNestedFields() throws {
        let json =
            #"{"amount":123456789.01234567890123456789,"text":"123456789.01234567890123456789","future":{"ids":[true,null,"A"],"delta":-0.00000000000000000001}}"#
        let value = try JSONDecoder().decode(TaxValue.self, from: Data(json.utf8))
        #expect(value["amount"] == .number(Decimal(string: "123456789.01234567890123456789")!))
        #expect(value["text"]?.stringValue == "123456789.01234567890123456789")
        #expect(value["future"]?["ids"] == .array([.bool(true), .null, .string("A")]))
        let encoded = try APIBody.encode(value)
        #expect(try JSONDecoder().decode(TaxValue.self, from: encoded) == value)
        #expect(String(decoding: encoded, as: UTF8.self).contains("123456789.01234567890123456789"))
    }

    /// MarkAsFiledDialog (main, 2026-10-18): filing the live year pins its household as that
    /// year's snapshot before the filing is recorded.
    @Test func filingTheLiveYearPinsInputsAndRecordsCreatedBeforeFiled() throws {
        let fixture = try MutationFixture(year: 2025)
        let patch = try #require(
            try TaxYearMutation.patch(
                action: .file(reference: "  synthetic-reference  "), overview: fixture.overview(),
                computation: fixture.computation, at: mutationTimestamp))
        let snapshot = try #require(patch.settings[TaxYearMutation.snapshotsKey]?["2025"])
        #expect(snapshot["taxYear"] == .number(2025))
        #expect(snapshot["partners"] == fixture.live["partners"])
        #expect(snapshot["futureInput"] == fixture.live["futureInput"])
        let meta = try #require(patch.settings[TaxYearMutation.metadataKey]?["2025"])
        #expect(meta["frozenCalculation"] == (try TaxValue(encoding: fixture.computation.calculation)))
        #expect(meta["frozenHouseholdResult"] == (try TaxValue(encoding: fixture.computation.result)))
        #expect(meta["filing"]?["reference"] == .string("synthetic-reference"))
        #expect(meta["filing"]?["filedAt"] == .string("2026-10-13T12:00:00.000Z"))
        #expect(meta["history"]?.arrayValue?.map { $0["kind"] } == [.string("created"), .string("filed")])
        #expect(meta["futureMeta"] == .string("keep"))
        #expect(patch.settings[TaxYearMutation.snapshotsKey]?["2023"] == fixture.snapshots["2023"])
        #expect(patch.settings[TaxYearMutation.metadataKey]?["2023"] == fixture.metadata["2023"])
    }

    /// A past year that would only use a live estimate cannot be filed.
    @Test func anEstimateOnlyHistoricalYearCannotBeFiled() throws {
        let fixture = try MutationFixture(year: 2024)
        let overview = try fixture.overview()
        #expect(!TaxYearMutation.canFile(overview))
        #expect(
            try TaxYearMutation.patch(
                action: .file(reference: nil), overview: overview, computation: fixture.computation) == nil)
        #expect(TaxYearMutation.canFile(try MutationFixture(year: 2024, frozen: true).overview()))
        #expect(TaxYearMutation.canFile(try MutationFixture(year: 2025).overview()))
        #expect(!TaxYearMutation.canFile(try MutationFixture(year: 2024, frozen: true, filed: true).overview()))
    }

    @Test func filingFrozenYearRetainsTheOldFiguresWithoutPinningTodaysLiveInputs() throws {
        let fixture = try MutationFixture(frozen: true)
        let patch = try #require(
            try TaxYearMutation.patch(
                action: .file(reference: " \n "), overview: fixture.overview(), at: mutationTimestamp))
        #expect(patch.settings[TaxYearMutation.snapshotsKey]?["2024"] == nil)
        let meta = patch.settings[TaxYearMutation.metadataKey]?["2024"]
        #expect(meta?["frozenCalculation"] == fixture.metadata["2024"]?["frozenCalculation"])
        #expect(meta?["frozenHouseholdResult"] == fixture.metadata["2024"]?["frozenHouseholdResult"])
        #expect(meta?["filing"]?["reference"] == nil)
        #expect(meta?["history"]?.arrayValue?.map { $0["kind"] } == [.string("filed")])
    }

    @Test func unfilingPreservesFrozenFiguresAndUnfreezingOnlyRemovesBothFrozenResults() throws {
        let filed = try MutationFixture(frozen: true, filed: true)
        let unfile = try #require(try TaxYearMutation.patch(action: .unfile, overview: filed.overview()))
        let meta = unfile.settings[TaxYearMutation.metadataKey]?["2024"]
        #expect(meta?["filing"] == nil)
        #expect(meta?["frozenCalculation"] == filed.metadata["2024"]?["frozenCalculation"])
        #expect(meta?["frozenHouseholdResult"] == filed.metadata["2024"]?["frozenHouseholdResult"])
        #expect(meta?["futureMeta"] == .string("keep"))
        #expect(meta?["history"]?.arrayValue?.last?["kind"] == .string("unfiled"))
        #expect(try TaxYearMutation.patch(action: .unfreeze, overview: filed.overview()) == nil)
        let frozen = try MutationFixture(frozen: true)
        let unfreeze = try #require(try TaxYearMutation.patch(action: .unfreeze, overview: frozen.overview()))
        let unfrozenMeta = unfreeze.settings[TaxYearMutation.metadataKey]?["2024"]
        #expect(unfrozenMeta?["frozenCalculation"] == nil)
        #expect(unfrozenMeta?["frozenHouseholdResult"] == nil)
        #expect(unfrozenMeta?["futureMeta"] == .string("keep"))
        #expect(unfrozenMeta?["history"]?.arrayValue?.last?["kind"] == .string("unfrozen"))
        #expect(unfreeze.settings[TaxYearMutation.snapshotsKey] == frozen.snapshots)
    }

    @Test func historyCapsAt200AndRetainsOtherMetadataYearsAndUnknownValues() throws {
        var fixture = try MutationFixture(frozen: true)
        fixture.metadata["2024"]?["history"] = .array(
            (0..<200).map {
                .object(["kind": .string("patched"), "index": .number(Decimal($0)), "futureEvent": .bool(true)])
            })
        let patch = try #require(try TaxYearMutation.patch(action: .unfreeze, overview: fixture.overview()))
        let history = try #require(patch.settings[TaxYearMutation.metadataKey]?["2024"]?["history"]?.arrayValue)
        #expect(history.count == 200)
        #expect(history.first?["index"] == .number(1))
        #expect(history.first?["futureEvent"] == .bool(true))
        #expect(history.last?["kind"] == .string("unfrozen"))
        #expect(patch.settings[TaxYearMutation.metadataKey]?["2023"] == fixture.metadata["2023"])
    }

    @Test func allThreeCasBaselinesRetainAbsentAndLegacyStringTokens() throws {
        let fixture = try MutationFixture()
        let records = try fixture.records().map { setting in
            let expected: JSONValue
            if setting.key == TaxYearMutation.householdKey {
                expected = .object(["exists": .bool(true), "value": .string("{\"legacy-token\":true}")])
            } else if setting.key == TaxYearMutation.snapshotsKey {
                expected = .object(["exists": .bool(false)])
            } else {
                expected = setting.expected
            }
            return OpenAPI.Setting(
                key: setting.key, value: setting.key == TaxYearMutation.snapshotsKey ? .null : setting.value,
                expected: expected)
        }
        let patch = try #require(
            try TaxYearMutation.patch(
                action: .freeze, overview: fixture.overview(records: records), computation: fixture.computation))
        #expect(Set(patch.settings.keys) == Set(mutationKeys))
        #expect(Set(patch.expected.keys) == Set(mutationKeys))
        #expect(patch.settings[TaxYearMutation.snapshotsKey]?["2023"]?["taxYear"] == .number(2023))
        for record in records { #expect(patch.expected[record.key] == record.expected) }
    }

    @Test func malformedMissingOrDuplicateBaselinesNeverProduceAWritePatch() throws {
        let fixture = try MutationFixture()
        let records = try fixture.records()
        let cases = [
            Array(records.dropLast()), records + [records[0]],
            records.map { OpenAPI.Setting(key: $0.key, value: $0.value, expected: .object(["exists": .bool(true)])) },
            records.map {
                OpenAPI.Setting(
                    key: $0.key, value: $0.value, expected: .object(["exists": .bool(false), "value": .null]))
            },
        ]
        for incomplete in cases {
            #expect(throws: APIError.self) {
                try TaxYearMutation.patch(action: .createSnapshot, overview: fixture.overview(records: incomplete))
            }
        }
        #expect(throws: APIError.self) {
            try TaxSettingsPatch(settings: ["unrelated": .bool(true)], records: records)
        }
    }

    @Test func unreadableSourcesAndInvalidHistoryCannotBeOverwrittenByYearActions() throws {
        var fixture = try MutationFixture()
        #expect(throws: APIError.self) {
            try TaxYearMutation.patch(action: .createSnapshot, overview: fixture.overview(invalid: true))
        }
        fixture.metadata["2024"]?["history"] = .string("unreadable")
        #expect(throws: APIError.self) {
            try TaxYearMutation.patch(action: .createSnapshot, overview: fixture.overview())
        }
        let corrupt = try fixture.records().map {
            OpenAPI.Setting(key: $0.key, value: .string("unreadable"), expected: $0.expected)
        }
        #expect(throws: APIError.self) {
            try TaxYearMutation.patch(action: .createSnapshot, overview: fixture.overview(records: corrupt))
        }
    }

    @Test func freezingRequiresTheSelectedYearsServerComputation() throws {
        let fixture = try MutationFixture()
        #expect(throws: APIError.self) {
            try TaxYearMutation.patch(action: .freeze, overview: fixture.overview())
        }
        let wrong = try MutationFixture(year: 2023)
        #expect(throws: APIError.self) {
            try TaxYearMutation.patch(action: .freeze, overview: fixture.overview(), computation: wrong.computation)
        }
        let patch = try #require(
            try TaxYearMutation.patch(
                action: .freeze, overview: fixture.overview(), computation: fixture.computation))
        #expect(
            patch.settings[TaxYearMutation.metadataKey]?["2024"]?["frozenCalculation"]?["totalPIT"]
                == .number(Decimal(string: "10994.5175")!))
    }

    @Test func bulkSettingsApiSendsExactSourceBaselinesAndDecimalValues() async throws {
        let fixture = try MutationFixture()
        let patch = try #require(
            try TaxYearMutation.patch(
                action: .freeze, overview: fixture.overview(), computation: fixture.computation))
        let transport = MutationTransport(saved: 3)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3100") }, transport: transport, maxRetries: 0)
        try await client.saveTaxSettings(patch)
        let request = try #require(await transport.requests.first)
        #expect(request.method == .put)
        #expect(request.url.path == "/api/settings")
        #expect(request.body == (try APIBody.encode(patch)))
        let body = try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
        #expect(
            body["settings"]?[TaxYearMutation.metadataKey]?["2024"]?["frozenCalculation"]?["totalPIT"]
                == .number(Decimal(string: "10994.5175")!))
        #expect(body["expected"]?.objectValue?.count == 3)
    }

    @Test func acknowledgedSavedCountMustMatchEverySubmittedTaxKey() async throws {
        let fixture = try MutationFixture()
        let patch = try #require(try TaxYearMutation.patch(action: .createSnapshot, overview: fixture.overview()))
        let transport = MutationTransport(saved: 2)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3100") }, transport: transport, maxRetries: 0)
        let error = await #expect(throws: APIError.self) { try await client.saveTaxSettings(patch) }
        if case .contract(let details) = error {
            #expect(details.endpoint == "/api/settings")
        } else {
            Issue.record("A partial acknowledgement must be a contract failure")
        }
        #expect(await transport.requests.count == 1)
    }
}

@MainActor
@Suite("Native tax year action persistence")
struct TaxActionsMutationTests {
    @Test func filingAlreadyFrozenYearNeverRunsTodaysEngine() async throws {
        let service = try MutationActionService(frozen: true)
        let overview = TaxOverviewModel(service: service)
        await overview.load(year: 2024)
        let actions = TaxActionsModel(
            overview: overview, computations: service, settings: service, now: { mutationTimestamp })
        #expect(await actions.perform(.file(reference: "reference")))
        #expect(await service.computeCount == 0)
        #expect(await service.writes.count == 1)
        #expect(await service.overviewCount == 2)
        #expect(actions.error == nil)
    }

    @Test func unknownWriteFailureRefreshesAuthoritativeStateAndKeepsTheError() async throws {
        let service = try MutationActionService(frozen: true, failAfterWrite: true)
        let overview = TaxOverviewModel(service: service)
        await overview.load(year: 2024)
        let actions = TaxActionsModel(overview: overview, computations: service, settings: service)
        #expect(!(await actions.perform(.unfreeze)))
        #expect(await service.writes.count == 1)
        #expect(await service.overviewCount == 2)
        #expect(!overview.isFrozen)
        #expect(actions.error?.contains("Synthetic lost acknowledgement") == true)
        #expect(!actions.isSaving)
    }

    @Test func aFailedServerComputationIsReportedForTheYearAndWritesNothing() async throws {
        let service = try MutationActionService(failCompute: true)
        let overview = TaxOverviewModel(service: service)
        await overview.load(year: 2024)
        let actions = TaxActionsModel(overview: overview, computations: service, settings: service)
        #expect(!(await actions.perform(.freeze)))
        #expect(await service.writes.isEmpty)
        #expect(actions.computeFailure?.year == 2024)
        #expect(actions.computeFailure?.detail.contains("Synthetic compute failure") == true)
        actions.clearComputeFailure()
        #expect(actions.computeFailure == nil)
    }

    @Test func unreadableSourceStopsAnActionBeforePersistence() async throws {
        let service = try MutationActionService(invalid: true)
        let overview = TaxOverviewModel(service: service)
        await overview.load(year: 2024)
        let actions = TaxActionsModel(overview: overview, computations: service, settings: service)
        #expect(!(await actions.perform(.createSnapshot)))
        #expect(await service.writes.isEmpty)
        #expect(await service.overviewCount == 1)
        #expect(actions.error != nil)
    }
}

private let mutationKeys = [TaxYearMutation.householdKey, TaxYearMutation.snapshotsKey, TaxYearMutation.metadataKey]
private let mutationTimestamp = Date(timeIntervalSince1970: 1_791_892_800)

private struct MutationFixture: Sendable {
    let year: Int
    var live: TaxValue
    var snapshots: TaxValue
    var metadata: TaxValue
    let computation: OpenAPI.BelgianTaxComputation
    init(year: Int = 2024, frozen: Bool = false, filed: Bool = false) throws {
        self.year = year
        live = try JSONDecoder().decode(TaxValue.self, from: Data(mutationHouseholdJSON.utf8))
        live["futureInput"] = .object(["retain": .bool(true)])
        var previous = live
        previous["taxYear"] = .number(2023)
        snapshots = .object(["2023": previous])
        var engine = try JSONDecoder().decode(TaxValue.self, from: Data(mutationComputationJSON.utf8))
        engine["result"]?["incomeYear"] = .number(Decimal(year))
        computation = try engine.decode(OpenAPI.BelgianTaxComputation.self)
        var meta: TaxValue = .object(["futureMeta": .string("keep")])
        if frozen {
            meta["frozenCalculation"] = .object([
                "totalPIT": .number(Decimal(string: "123.4567")!), "oldEngineOnly": .string("preserve"),
            ])
            var result = engine["result"]!
            result["futureResult"] = .bool(true)
            meta["frozenHouseholdResult"] = result
        }
        if filed {
            meta["filing"] = .object(["filedAt": .string("2025-03-01T00:00:00Z"), "reference": .string("old")])
        }
        metadata = .object(["2023": .object(["futureYear": .string("preserve")])])
        metadata[String(year)] = meta
    }
    func records() throws -> [OpenAPI.Setting] {
        try [
            (TaxYearMutation.householdKey, live), (TaxYearMutation.snapshotsKey, snapshots),
            (TaxYearMutation.metadataKey, metadata),
        ].map { key, value in
            let json = try value.decode(JSONValue.self)
            return OpenAPI.Setting(key: key, value: json, expected: .object(["exists": .bool(true), "value": json]))
        }
    }
    func overview(records: [OpenAPI.Setting]? = nil, invalid: Bool = false) throws -> OpenAPI.BelgianTaxOverview {
        let householdValue = snapshots[String(year)] ?? live
        var selected = householdValue
        selected["taxYear"] = .number(Decimal(year))
        let household = try selected.decode(OpenAPI.BelgianTaxHouseholdInput.self)
        let meta = metadata[String(year)] ?? .object([:])
        let frozen = meta["frozenCalculation"] != nil
        let calculation = try (meta["frozenCalculation"] ?? TaxValue(encoding: computation.calculation)).decode(
            OpenAPI.BelgianTaxHistoricalCalculation.self)
        return try OpenAPI.BelgianTaxOverview(
            year: year, liveYear: 2025, isHistorical: year != 2025, hasSnapshot: snapshots[String(year)] != nil,
            hasProfile: true, householdMigrationNeeded: false, snapshotsMigrationNeeded: false,
            storedValueInvalid: invalid,
            household: household, liveHousehold: live.decode(OpenAPI.BelgianTaxHouseholdInput.self),
            householdSnapshots: snapshots.decode([String: OpenAPI.BelgianTaxHouseholdInput].self),
            snapshotMetas: metadata.decode([String: JSONValue].self), metadata: meta.decode(JSONValue.self),
            calculation: calculation, result: computation.result, calculationSource: frozen ? .frozen : .computed,
            householdResultSource: meta["frozenHouseholdResult"] == nil ? .computed : .frozen, warnings: [],
            records: records ?? self.records())
    }
}

private actor MutationTransport: APITransport {
    let saved: Int
    var requests: [APIRequest] = []
    init(saved: Int) { self.saved = saved }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":{\"saved\":\(saved)}}".utf8))
    }
}

private actor MutationActionService: TaxComputationService, TaxSettingsService {
    var fixture: MutationFixture
    let invalid: Bool
    let failAfterWrite: Bool
    let failCompute: Bool
    var writes: [TaxSettingsPatch] = []
    var computeCount = 0
    var overviewCount = 0
    init(frozen: Bool = false, invalid: Bool = false, failAfterWrite: Bool = false, failCompute: Bool = false) throws {
        fixture = try MutationFixture(frozen: frozen)
        self.invalid = invalid
        self.failAfterWrite = failAfterWrite
        self.failCompute = failCompute
    }
    func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation {
        computeCount += 1
        if failCompute { throw APIError.network("Synthetic compute failure") }
        return fixture.computation
    }
    func taxOverview(year: Int?) async throws -> OpenAPI.BelgianTaxOverview {
        overviewCount += 1
        return try fixture.overview(invalid: invalid)
    }
    func saveTaxSettings(_ patch: TaxSettingsPatch) async throws {
        writes.append(patch)
        fixture.live = patch.settings[TaxYearMutation.householdKey]!
        fixture.snapshots = patch.settings[TaxYearMutation.snapshotsKey]!
        fixture.metadata = patch.settings[TaxYearMutation.metadataKey]!
        if failAfterWrite { throw APIError.network("Synthetic lost acknowledgement") }
    }
}

// Independent synthetic SC-01 wire fixture; no Swift tax calculation is performed.
private let mutationHouseholdJSON = #"""
    {
      "version": 2,
      "taxYear": 2025,
      "profileConfigured": true,
      "region": "flanders",
      "communalSurchargePercent": 7,
      "partners": [
        {
          "id": "A",
          "isDisabled": false,
          "activities": [
            {
              "id": "act_A_1",
              "kind": "employee",
              "grossIncome": 50000
            }
          ],
          "professionalExpenses": {},
          "unionDues": 0,
          "otherTaxableIncome": 0,
          "alimonyPaid": 0,
          "reductions": {
            "personalPensionContributions": 0,
            "lifeInsurancePremiums": 0,
            "charitableDonations": 0,
            "childcareCosts": 0,
            "medicalExpenses": 0
          }
        }
      ],
      "relationship": {
        "events": []
      },
      "dependents": {
        "children": 0,
        "otherPersons": 0
      },
      "home": {
        "cadastralIncome": 0,
        "mortgageInterestPaid": 0
      }
    }
    """#
private let mutationComputationJSON = #"""
    {
      "result": {
        "engineVersion": 2,
        "incomeYear": 2025,
        "assessment": {
          "mode": "single",
          "reason": "one_partner",
          "legalBasis": "WIB 92 art. 126 \u00a71",
          "partnerIds": [
            "A"
          ]
        },
        "partners": [
          {
            "partnerId": "A",
            "activities": [
              {
                "activityId": "act_A_1",
                "kind": "employee",
                "forfaitCategory": "remuneration",
                "grossIncome": 50000,
                "employeeSocialSecurity": 6535.000000000001,
                "socialContributionsPaid": 0,
                "professionalExpenses": 5930,
                "netProfessionalIncome": 37535
              }
            ],
            "categories": [
              {
                "category": "remuneration",
                "method": "lump_sum",
                "grossAfterContributions": 43465,
                "professionalExpenses": 5930,
                "unionDuesApplied": 0,
                "netIncome": 37535
              }
            ],
            "grossIncome": 50000,
            "employeeSocialSecurity": 6535.000000000001,
            "professionalExpenses": 5930,
            "unionDuesApplied": 0,
            "netProfessionalIncome": 37535,
            "otherTaxableIncome": 0,
            "alimonyDeduction": 0,
            "taxableIncomeBeforeQuotient": 37535,
            "quotientAdjustment": 0,
            "taxableIncome": 37535,
            "bracketTax": {
              "b1": 4080,
              "b2": 4992,
              "b3": 3930.75,
              "b4": 0,
              "total": 13002.75
            },
            "exemption": {
              "basic": 10910,
              "disability": 0,
              "dependentSupplements": 0,
              "isolatedParentSupplement": 0,
              "ownTotal": 10910,
              "transferredIn": 0,
              "transferredOut": 0,
              "total": 10910,
              "applied": 10910
            },
            "exemptionBenefit": 2727.5,
            "pitAfterExemption": 10275.25,
            "reductions": {
              "pension": 0,
              "lifeInsurance": 0,
              "groupInsurance": 0,
              "donations": 0,
              "childcare": 0,
              "domesticHelp": 0,
              "serviceVouchers": 0,
              "total": 0
            },
            "ownHomeCreditRegime": "none",
            "ownHomeCredit": 0,
            "pensionReduction": 0,
            "reductionsApplied": 0,
            "federalPITAfterReductions": 10275.25,
            "communalSurcharge": 719.2675,
            "totalPIT": 10994.5175,
            "specialSocialSecurityContribution": 343.15719,
            "csssSubject": true,
            "dividendWhtReclaim": 0,
            "savingsInterestTax": 0,
            "marginalRate": 45
          }
        ],
        "quotient": {
          "applied": false,
          "transfer": 0,
          "target": 0,
          "cap": 13460,
          "benefit": 0
        },
        "csss": {
          "scale": "single",
          "base": 37535,
          "total": 343.15719
        },
        "propertyTaxEstimate": 0,
        "totals": {
          "grossIncome": 50000,
          "employeeSocialSecurity": 6535.000000000001,
          "professionalExpenses": 5930,
          "netProfessionalIncome": 37535,
          "taxableIncome": 37535,
          "federalPITBeforeExemption": 13002.75,
          "personalExemptionBenefit": 2727.5,
          "taxReductions": 2727.5,
          "federalPITAfterReductions": 10275.25,
          "communalSurcharge": 719.2675,
          "totalPIT": 10994.5175,
          "specialSocialSecurityContribution": 343.15719,
          "propertyTaxEstimate": 0,
          "totalTaxBurden": 17872.674690000003,
          "netTakeHome": 32127.325309999997,
          "dividendWhtReclaim": 0,
          "savingsInterestTax": 0,
          "refundableChildCredit": 0
        },
        "issues": []
      },
      "calculation": {
        "grossIncome": 50000,
        "spouseProfessionalIncome": 0,
        "householdGrossIncome": 50000,
        "employeeSocialSecurity": 6535.000000000001,
        "specialSocialSecurityContribution": 343.15719,
        "personalExemptionAmount": 10910,
        "netIncomeAfterSS": 43465,
        "professionalExpenses": 5930,
        "otherDeductionsTotal": 0,
        "deductions": {
          "alimonyPaid": 0,
          "personalPensionContributions": 0,
          "lifeInsurancePremiums": 0,
          "mortgageInterestPaid": 0,
          "charitableDonations": 0,
          "childcareCosts": 0,
          "unionDues": 0,
          "medicalExpenses": 0
        },
        "taxableIncome": 37535,
        "federalPITBracket1": 4080,
        "federalPITBracket2": 4992,
        "federalPITBracket3": 3930.75,
        "federalPITBracket4": 0,
        "federalPITBeforeExemption": 13002.75,
        "personalExemptionBenefit": 2727.5,
        "federalTaxCredits": 0,
        "ownHomeCreditRegime": "none",
        "ownHomeCredit": 0,
        "taxReductions": 2727.5,
        "pensionReduction": 0,
        "federalPITAfterReductions": 10275.25,
        "communalSurcharge": 719.2675,
        "totalPIT": 10994.5175,
        "totalTaxBurden": 17872.674690000003,
        "effectiveRate": 35.74534938000001,
        "marginalRate": 45,
        "netTakeHome": 32127.325309999997,
        "monthlyTaxReserve": 916.2097916666667,
        "propertyTaxEstimate": 0,
        "dividendWhtReclaim": 0,
        "savingsInterestTax": 0,
        "maritalQuotientTransfer": 0,
        "maritalQuotientBenefit": 0,
        "serviceVoucherCredit": 0,
        "breakdown": [
          {
            "label": "Gross Income",
            "amount": 50000
          },
          {
            "label": "Employee Social Security",
            "amount": -6535.000000000001,
            "rate": 13.07
          },
          {
            "label": "Net after Social Security",
            "amount": 43465
          },
          {
            "label": "Professional Expenses Deduction",
            "amount": -5930
          },
          {
            "label": "Taxable Income",
            "amount": 37535
          },
          {
            "label": "Bracket 1 (25%)",
            "bracketNumber": 1,
            "amount": -4080,
            "rate": 25,
            "bracket": "\u20ac0 \u2013 \u20ac16320"
          },
          {
            "label": "Bracket 2 (40%)",
            "bracketNumber": 2,
            "amount": -4992,
            "rate": 40,
            "bracket": "\u20ac16320 \u2013 \u20ac28800"
          },
          {
            "label": "Bracket 3 (45%)",
            "bracketNumber": 3,
            "amount": -3930.75,
            "rate": 45,
            "bracket": "\u20ac28800 \u2013 \u20ac49840"
          },
          {
            "label": "Personal exemption benefit",
            "amount": -2727.5
          },
          {
            "label": "Federal PIT (before exemption)",
            "amount": -13002.75
          },
          {
            "label": "Federal PIT (after credits)",
            "amount": -10275.25
          },
          {
            "label": "Communal Surcharge (7%)",
            "amount": -719.2675,
            "rate": 7
          },
          {
            "label": "Special Social Security Contribution",
            "amount": -343.15719
          },
          {
            "label": "Net Take-Home",
            "amount": 32127.325309999997
          }
        ]
      }
    }
    """#
