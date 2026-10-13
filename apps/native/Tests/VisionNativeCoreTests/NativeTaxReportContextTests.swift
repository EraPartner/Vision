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
}
