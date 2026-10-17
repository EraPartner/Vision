import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Original tax report context") @MainActor struct NativeTaxReportContextTests {
    private static let precise = Decimal(string: "1234567890.1234567890123456789")!
    private let profile: TaxValue = .object([
        "employmentType": .string("self_employed"), "filingStatus": .string("married"),
        "region": .string("wallonia"), "taxYear": .number(2020),
    ])
    private func overview(
        partners: Int = 2, frozen: Bool = false, frozenHousehold: Bool = false, configured: Bool = true
    ) -> TaxValue {
        let calculation: TaxValue = .object([
            "taxableIncome": .number(Self.precise), "totalPIT": .number(12345),
            "unknownFutureAmount": .number(Self.precise),
            "breakdown": .array([
                .object([
                    "label": .string("Source bracket"), "bracket": .string("0–15200"), "bracketNumber": .number(1),
                    "rate": .number(25), "amount": .number(3800),
                ]),
                .object([
                    "label": .string("Legacy bracket"), "bracket": .string("legacy"), "rate": .number(40),
                    "amount": .number(8543),
                ]),
                .object(["label": .string("Non-bracket"), "amount": .number(777)]),
            ]),
        ])
        let result: TaxValue = .object([
            "assessment": .object([
                "mode": .string("joint"), "legalBasis": .string("Original basis"), "other": .string("not in report"),
            ]),
            "quotient": .object([
                "applied": .bool(true), "transfer": .number(Self.precise), "fromPartnerId": .string("A"),
                "toPartnerId": .string("B"), "benefit": .number(12),
            ]),
            "partners": .array(
                (0..<partners).map { index in
                    .object([
                        "partnerId": .string(index == 0 ? "A" : "B"), "grossIncome": .number(Self.precise),
                        "taxableIncome": .number(10000), "totalPIT": .number(500), "notInReport": .number(9),
                    ])
                }),
        ])
        var metadata: [String: TaxValue] = [:]
        if frozen { metadata["frozenCalculation"] = calculation }
        if frozenHousehold { metadata["frozenHouseholdResult"] = result }
        return .object([
            "year": .number(2020), "hasProfile": .bool(configured), "metadata": .object(metadata),
            "calculation": calculation, "result": result,
            "household": .object([
                "version": .number(2), "taxYear": .number(2020), "unknownFutureField": .number(Self.precise),
                "partners": .array((0..<partners).map { .object(["id": .string($0 == 0 ? "A" : "B")]) }),
            ]),
        ])
    }
    private func make(_ overview: TaxValue) throws -> TaxValue {
        try NativeTaxReportContext.make(
            overview: overview, requestedYear: 2020, projectedProfile: profile, localize: { "nl:\($0)" })
    }
    @Test func fullyFrozenContextCarriesOriginalPreciseHouseholdAndFigures() throws {
        let source = overview(frozen: true, frozenHousehold: true)
        let context = try make(source)
        #expect(context["household"] == source["household"])
        #expect(context["precomputedPIT"]?["taxableIncome"] == .number(Self.precise))
        #expect(context["precomputedPIT"]?["totalTax"] == .number(12345))
        #expect(
            context["precomputedHousehold"]?["partners"]?.arrayValue?.first?["grossIncome"] == .number(Self.precise))
        #expect(context["precomputedHousehold"]?["quotient"]?["transfer"] == .number(Self.precise))
        let encoded = try APIBody.encode(context)
        #expect(try JSONDecoder().decode(TaxValue.self, from: encoded) == context)
    }
    @Test func reportProfileUsesEmploymentMetadataAndSelectedYear() throws {
        let context = try make(overview())
        #expect(
            context["taxProfile"]
                == .object([
                    "filingStatus": .string("self_employed"), "region": .string("wallonia"), "taxYear": .number(2020),
                ]))
    }
    @Test func bracketsUseLocalizedOrdinalLabelsAndOriginalPercentRates() throws {
        let context = try make(overview())
        #expect(
            context["precomputedPIT"]?["brackets"]
                == .array([
                    .object([
                        "label": .string("nl:tax.pit.row.bracket1"), "rate": .number(25), "taxAmount": .number(3800),
                    ]),
                    .object(["label": .string("Legacy bracket"), "rate": .number(40), "taxAmount": .number(8543)]),
                ]))
    }
    @Test func legacyFrozenCalculationNeverBorrowsFreshHouseholdResult() throws {
        let source = overview(frozen: true, frozenHousehold: false)
        let context = try make(source)
        #expect(context["precomputedPIT"] != nil && context["household"] == source["household"])
        #expect(context["precomputedHousehold"] == nil)
    }
    @Test func liveHouseholdSummaryOnlyProjectsOriginalAmountFields() throws {
        let context = try make(overview())
        let summary = try #require(context["precomputedHousehold"])
        #expect(summary["assessmentMode"] == .string("joint") && summary["legalBasis"] == .string("Original basis"))
        #expect(summary["partners"]?.arrayValue?.first?["notInReport"] == nil)
        #expect(summary["quotient"]?["fromPartnerId"] == .string("A"))
    }
    @Test func singlePartnerOmitsHouseholdBlocks() throws {
        var source = overview(partners: 1)
        source["result"] = .null
        let context = try make(source)
        #expect(context["household"] == nil && context["precomputedHousehold"] == nil)
        #expect(context["precomputedPIT"] != nil)
    }
    @Test func unconfiguredSourceOmitsFiscalBlocks() throws {
        let context = try NativeTaxReportContext.make(
            overview: .object(["year": .number(2020), "hasProfile": .bool(false)]),
            requestedYear: 2020, projectedProfile: nil, localize: { $0 })
        #expect(context == .object([:]))
    }
    @Test func missingOrDifferentYearAuthorityDoesNotFallBackToLiveData() {
        var source = overview()
        source["year"] = .number(2026)
        #expect(throws: APIError.self) { try make(source) }
        source = overview()
        source["household"]?["taxYear"] = .number(2026)
        #expect(throws: APIError.self) { try make(source) }
        source = overview()
        source["calculation"]?["breakdown"] = nil
        #expect(throws: APIError.self) { try make(source) }
    }
    @Test func serviceReadsOneRawYearAndPassesSameHouseholdToSharedProjection() async throws {
        let source = overview(frozen: true, frozenHousehold: true)
        let bytes = try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": source]))
        let transport = ReportTestTransport(APIResponse(status: 200, body: bytes))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        var projected: [(TaxValue, Int)] = []
        let service = NativeTaxReportContextService(
            client: client, localize: { $0 },
            projectProfile: { household, year in
                projected.append((household, year))
                return profile
            })
        let context = try await service.context(year: 2020)
        #expect(projected.count == 1 && projected.first?.0 == source["household"] && projected.first?.1 == 2020)
        #expect(context["household"] == source["household"])
        #expect(await transport.requests.count == 1)
        let request = try #require(await transport.requests.first)
        #expect(request.method == .get && request.url.path == "/api/belgian-tax/overview")
        #expect(
            URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems == [
                URLQueryItem(name: "year", value: "2020")
            ])
    }
    @Test func unconfiguredServiceDoesNotInvokeProjection() async throws {
        let source = overview(configured: false)
        let transport = ReportTestTransport(
            APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": source]))))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let service = NativeTaxReportContextService(
            client: client, localize: { $0 },
            projectProfile: { _, _ in
                Issue.record("Unconfigured profile must not project a tax context")
                return .object([:])
            })
        #expect(try await service.context(year: 2020) == .object([:]))
    }
    @Test(arguments: [(0, "0000"), (850, "0850"), (2201, "2201"), (9999, "9999")])
    func everyFourDigitYearReadsThePaddedOverview(_ year: Int, _ query: String) async throws {
        let source: TaxValue = .object(["year": .number(Decimal(year)), "hasProfile": .bool(false)])
        let transport = ReportTestTransport(
            APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": source]))))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let service = NativeTaxReportContextService(client: client, localize: { $0 })
        #expect(try await service.context(year: year) == .object([:]))
        let request = try #require(await transport.requests.first)
        #expect(request.url.path == "/api/belgian-tax/overview")
        #expect(
            URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems == [
                URLQueryItem(name: "year", value: query)
            ])
        #expect(await transport.requests.count == 1)
    }
    @Test(arguments: [-1, 10_000])
    func yearsWithoutFourDigitsAreRejectedBeforeAnyRead(_ year: Int) async {
        let transport = ReportTestTransport(APIResponse(status: 200, body: Data()))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let service = NativeTaxReportContextService(client: client, localize: { $0 })
        await #expect(throws: APIError.self) { try await service.context(year: year) }
        #expect(await transport.requests.isEmpty)
    }
    @Test func theDefaultProjectionFeedsTheReportProfile() async throws {
        var source = overview()
        source["household"]?["region"] = .string("wallonia")
        let transport = ReportTestTransport(
            APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": source]))))
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:54331") }, transport: transport)
        let service = NativeTaxReportContextService(client: client, localize: { $0 })
        let context = try await service.context(year: 2020)
        #expect(context["taxProfile"]?["region"] == .string("wallonia"))
        #expect(context["taxProfile"]?["taxYear"] == .number(2020))
        #expect(context["taxProfile"]?["filingStatus"] != nil)
    }
    @Test func projectionPicksPartnerAsPrimaryActivityLikeTheSharedMigration() throws {
        func household(_ partners: [TaxValue]) -> TaxValue {
            .object(["region": .string("flanders"), "taxYear": .number(2025), "partners": .array(partners)])
        }
        func partner(_ id: String, _ activities: [(String, String)]) -> TaxValue {
            .object([
                "id": .string(id),
                "activities": .array(activities.map { .object(["id": .string($0.0), "kind": .string($0.1)]) }),
            ])
        }
        let explicit = household([
            partner("B", [("act_B_1", "pension")]),
            partner("A", [("act_A_2", "employee"), ("act_A_1", "self_employed_fees")]),
        ])
        #expect(
            try NativeTaxReportProfile.project(explicit)
                == .object([
                    "employmentType": .string("self_employed"), "region": .string("flanders"),
                    "taxYear": .number(2025),
                ]))
        let firstNonNet = household([partner("A", [("x", "net_professional_amount"), ("y", "director")])])
        #expect(try NativeTaxReportProfile.project(firstNonNet)["employmentType"] == .string("director"))
        let onlyNet = household([partner("A", [("x", "net_professional_amount")])])
        #expect(try NativeTaxReportProfile.project(onlyNet)["employmentType"] == .string("other"))
        let noActivities = household([partner("A", [])])
        #expect(try NativeTaxReportProfile.project(noActivities)["employmentType"] == .string("employee"))
        let noPartnerA = household([partner("B", [("act_B_1", "civil_servant")])])
        #expect(try NativeTaxReportProfile.project(noPartnerA)["employmentType"] == .string("civil_servant"))
        #expect(throws: APIError.self) { try NativeTaxReportProfile.project(.object([:])) }
    }
    @Test(arguments: [
        ("employee", "employee"), ("civil_servant", "civil_servant"), ("director", "director"),
        ("self_employed_profits", "self_employed"), ("self_employed_fees", "self_employed"),
        ("pension", "retired"), ("unemployment", "other"),
    ])
    func employmentTypesFollowEmploymentTypeFor(_ kind: String, _ expected: String) {
        #expect(NativeTaxReportProfile.employmentType(kind) == expected)
    }

}
