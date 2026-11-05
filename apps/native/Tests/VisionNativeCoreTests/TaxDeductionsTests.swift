import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native deduction replacements")
struct TaxDeductionsDataTests {
    @Test func candidateMoneyUsesDecimalAndBackendShares() throws {
        let group = try deductionGroup()
        #expect(group.total == Decimal(string: "235.15"))
        #expect(group.partnerShares?["B"] == Decimal(string: "100.13"))
        #expect(group.categories.first?.total == Decimal(string: "235.15"))
    }
    @Test func partnerAmountsReplaceIncludingZeroAndPreserveUnrelatedFields() throws {
        let value = try TaxDeductionApplication(year: 2025, group: deductionGroup(total: "50", a: "50", b: "0"))
            .applying(to: deductionHousehold())
        let a = try #require(value["partners"]?.arrayValue?.first)
        let b = try #require(value["partners"]?.arrayValue?.last)
        #expect(a["reductions"]?["personalPensionContributions"] == .number(50))
        #expect(a["reductions"]?["pensionEligible"] == .bool(true))
        #expect(b["reductions"]?["personalPensionContributions"] == .number(0))
        #expect(b["reductions"]?["pensionEligible"] == .bool(false))
        #expect(a["futureField"] == .string("retained"))
        #expect(b["reductions"]?["unknownMoney"] == .number(Decimal(string: "0.1234567")!))
        #expect(value["unrelated"] == .string("retained"))
    }
    @Test func singlePartnerReceivesWholeTotalWithoutBackendShares() throws {
        var household = try deductionHousehold()
        household["partners"] = .array([try #require(household["partners"]?.arrayValue?.first)])
        let group = try deductionGroup(shares: false)
        let value = try TaxDeductionApplication(year: 2025, group: group).applying(to: household)
        #expect(
            value["partners"]?.arrayValue?.first?["reductions"]?["personalPensionContributions"] == .number(group.total)
        )
    }
    @Test func twoPartnersCannotUseAnOlderBackendWithoutAttribution() throws {
        #expect(throws: APIError.self) {
            try TaxDeductionApplication(year: 2025, group: deductionGroup(shares: false)).applying(
                to: deductionHousehold())
        }
    }
    @Test func householdAndDirectPartnerFieldsRetainTheirPlacement() throws {
        let household = try deductionHousehold()
        let home = try TaxDeductionApplication(
            year: 2025, group: deductionGroup(type: "mortgageInterest", shares: false)
        ).applying(to: household)
        #expect(home["home"]?["mortgageInterestPaid"] == .number(Decimal(string: "235.15")!))
        #expect(home["home"]?["unknown"] == .string("retained"))
        let union = try TaxDeductionApplication(year: 2025, group: deductionGroup(type: "unionDues")).applying(
            to: household)
        #expect(union["partners"]?.arrayValue?.first?["unionDues"] == .number(Decimal(string: "135.02")!))
        #expect(union["partners"]?.arrayValue?.last?["unionDues"] == .number(Decimal(string: "100.13")!))
        #expect(union["partners"]?.arrayValue?.first?["reductions"]?["unionDues"] == nil)
    }
    @Test func suggestionsDecodeTheServerAmountWithoutInventingAnEstimate() throws {
        let data = Data(
            #"[{"id":"childcare.suggest","titleKey":"tax.suggestions.item.childcare","descriptionKey":"tax.suggestions.childcare.suggest","descriptionParams":{"days":120},"estimate":123.456789},{"id":"donations.no_amount","titleKey":"tax.suggestions.item.donations","descriptionKey":"tax.suggestions.donations.noAmount","noteKey":"tax.suggestions.donations.note"}]"#
                .utf8)
        let values = try JSONDecoder().decode([TaxDeductionSuggestion].self, from: data)
        #expect(values.first?.estimate == Decimal(string: "123.456789"))
        #expect(values.first?.descriptionParams?["days"] == 120)
        #expect(values.last?.estimate == nil)
    }
}

@Suite("Native deduction candidate API")
struct TaxDeductionsAPITests {
    @Test func adapterUsesGeneratedOperationWithTheRequestedYearAndDecimalAmounts() async throws {
        let json =
            "{\"ok\":true,\"data\":{\"year\":2025,\"from\":\"2025-01-01\",\"to\":\"2025-12-31\",\"currency\":\"EUR\",\"byDeductionType\":[{\"deductionType\":\"unionDues\",\"total\":123.456789,\"categoryCount\":1,\"categories\":[{\"category\":\"UNION:DUES\",\"total\":123.456789,\"count\":1}]}]}}"
        let transport = DeductionTransport(body: json)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let result = try await client.deductionCandidates(year: 2025)
        #expect(result.byDeductionType.first?.total == Decimal(string: "123.456789"))
        let request = try #require(await transport.requests.first)
        #expect(request.method == .get)
        #expect(request.url.path == "/api/info/deduction-candidates")
        #expect(
            URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems == [
                .init(name: "year", value: "2025")
            ])
    }
    @Test func missingRequiredTotalsAreContractFailuresInsteadOfAnEmptySuccess() async {
        let transport = DeductionTransport(
            body: #"{"ok":true,"data":{"year":2025,"currency":"EUR","byDeductionType":[]}}"#)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        do {
            _ = try await client.deductionCandidates(year: 2025)
            Issue.record("Expected a contract error for missing candidate date bounds")
        } catch let error as APIError {
            guard case .contract = error else {
                Issue.record("Expected contract failure")
                return
            }
        } catch { Issue.record("Unexpected error") }
    }
}

@MainActor @Suite("Native candidate query safety")
struct TaxDeductionsModelTests {
    @Test func failedRefreshBlocksCachedCandidateApplicationAndRetryRestoresIt() async throws {
        let service = DeductionFixtureService()
        let model = TaxDeductionsModel(service: service)
        await model.load(year: 2025)
        #expect(model.canConfirm)
        await service.setFailure(true)
        await model.load(year: 2025, force: true)
        #expect(model.data != nil)
        #expect(model.error != nil)
        #expect(!model.canConfirm)
        var applied = false
        let result = await model.apply(try deductionGroup()) { _ in
            applied = true
            return true
        }
        #expect(!result && !applied)
        await service.setFailure(false)
        await model.retry()
        #expect(model.error == nil && model.canConfirm)
    }
    @Test func yearChangeClearsPreviousAmountsAndFreshCacheAvoidsDuplicateRequests() async {
        let service = DeductionFixtureService()
        let model = TaxDeductionsModel(service: service)
        await model.load(year: 2025)
        await model.load(year: 2025)
        #expect(await service.years == [2025])
        await service.setFailure(true)
        await model.load(year: 2024)
        #expect(model.data == nil)
        #expect(model.groups.isEmpty)
    }
    @Test func dismissalAndAppliedMarkersAreScopedToTheYear() async throws {
        let service = DeductionFixtureService()
        let model = TaxDeductionsModel(service: service, now: { Date(timeIntervalSince1970: 1_767_225_600) })
        let storage = DeductionStorage()
        model.bindStorage(read: { await storage.read($0) }, write: { await storage.write($0, $1) })
        await model.load(year: 2025)
        #expect(!model.needsAcknowledgement())
        let group = try #require(model.groups.first)
        #expect(await model.apply(group) { _ in true })
        #expect(model.appliedTypes.contains(group.deductionType))
        await model.dismiss(group)
        #expect(model.groups.isEmpty)
        #expect(await storage.value?.contains("2025") == true)
        await model.load(year: 2026)
        #expect(model.needsAcknowledgement())
        #expect(!model.groups.isEmpty)
        #expect(model.appliedTypes.isEmpty)
    }
    @Test func validStoredDismissalsSurviveMalformedSiblingEntries() async {
        let service = DeductionFixtureService()
        let model = TaxDeductionsModel(service: service)
        let storage = DeductionStorage(value: #"[{"year":2025,"deductionType":"pensionSavings"},{"bad":"entry"},null]"#)
        model.bindStorage(read: { await storage.read($0) }, write: { await storage.write($0, $1) })
        await model.load(year: 2025)
        #expect(model.groups.isEmpty)
        await model.load(year: 2026)
        #expect(!model.groups.isEmpty)
    }
    @Test func invalidationDisablesApplyingCachedCandidatesUntilRefresh() async {
        let model = TaxDeductionsModel(service: DeductionFixtureService())
        await model.load(year: 2025)
        #expect(model.canConfirm)
        model.invalidate()
        #expect(!model.canConfirm)
        await model.load(year: 2025)
        #expect(model.canConfirm)
    }
    @Test func unknownAndNonpositiveCandidatesCannotBeApplied() async throws {
        let service = DeductionFixtureService()
        let model = TaxDeductionsModel(service: service)
        await model.load(year: 2025)
        var called = false
        #expect(
            await model.apply(try deductionGroup(type: "unrecognized")) { _ in
                called = true
                return true
            } == false)
        #expect(!called)
    }
}

private func deductionGroup(
    type: String = "pensionSavings", total: String = "235.15", a: String = "135.02", b: String = "100.13",
    shares: Bool = true
) throws -> TaxDeductionGroup {
    let extra = shares ? ",\"partnerShares\":{\"A\":\(a),\"B\":\(b)}" : ""
    let json =
        "{\"deductionType\":\"\(type)\",\"total\":\(total),\"byOwner\":{\"me\":115,\"partner\":80.1,\"joint\":40.05}\(extra),\"categoryCount\":1,\"categories\":[{\"category\":\"PENSION:SAVINGS\",\"total\":\(total),\"count\":3}]}"
    return try JSONDecoder().decode(TaxDeductionGroup.self, from: Data(json.utf8))
}
private func deductionHousehold() throws -> TaxValue {
    try JSONDecoder().decode(
        TaxValue.self,
        from: Data(
            #"{"taxYear":2025,"unrelated":"retained","home":{"mortgageInterestPaid":500,"unknown":"retained"},"partners":[{"id":"A","futureField":"retained","reductions":{"personalPensionContributions":1000,"pensionEligible":false}},{"id":"B","reductions":{"personalPensionContributions":900,"pensionEligible":false,"unknownMoney":0.1234567}}]}"#
                .utf8))
}
private actor DeductionFixtureService: TaxDeductionsService {
    var years: [Int] = []
    var fail = false
    func setFailure(_ value: Bool) { fail = value }
    func deductionCandidates(year: Int) async throws -> TaxDeductionCandidates {
        years.append(year)
        if fail { throw APIError.backendUnavailable }
        let group = try deductionGroup()
        // The response is read-only, so encode a small fixture rather than synthesising money.
        let json =
            "{\"year\":\(year),\"from\":\"\(year)-01-01\",\"to\":\"\(year)-12-31\",\"currency\":\"EUR\",\"byDeductionType\":[{\"deductionType\":\"\(group.deductionType)\",\"total\":235.15,\"partnerShares\":{\"A\":135.02,\"B\":100.13},\"categoryCount\":1,\"categories\":[{\"category\":\"PENSION:SAVINGS\",\"total\":235.15,\"count\":3}]}]}"
        return try JSONDecoder().decode(TaxDeductionCandidates.self, from: Data(json.utf8))
    }
}
private actor DeductionStorage {
    var value: String?
    init(value: String? = nil) { self.value = value }
    func read(_ key: String) -> String? { value }
    func write(_ key: String, _ value: String) { self.value = value }
}

private actor DeductionTransport: APITransport {
    let body: String
    var requests: [APIRequest] = []
    init(body: String) { self.body = body }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return APIResponse(status: 200, body: Data(body.utf8))
    }
}
