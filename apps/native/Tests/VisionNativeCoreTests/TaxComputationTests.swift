import Foundation
import Testing

@testable import VisionNativeCore

@Suite("TypeScript tax engine API")
struct TaxComputationTests {
    @Test func overviewReadsRequestedYearAndPreservesLegacyFrozenAmounts() async throws {
        let fixture = try taxOverviewFixture(year: 2024, frozen: true)
        let data = try APIBody.encode(fixture)
        let transport = TaxFixtureTransport(body: "{\"ok\":true,\"data\":\(String(decoding: data, as: UTF8.self))}")
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let result = try await client.taxOverview(year: 2024)
        #expect(result.calculation.totalPIT == Decimal(string: "123.4567"))
        #expect(result.calculation.grossIncome == nil)
        #expect(result.calculationSource == "frozen")
        #expect(result.householdResultSource == "computed")
        let request = try #require(await transport.requests.first)
        #expect(request.method == .get)
        #expect(request.url.path == "/api/belgian-tax/overview")
        #expect(URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first?.value == "2024")
    }
    @Test func computationPreservesDecimalFiguresAndTheCompleteHouseholdRequest() async throws {
        let household = try JSONDecoder().decode(
            OpenAPI.BelgianTaxHouseholdInput.self, from: Data(taxHouseholdFixture.utf8))
        let transport = TaxFixtureTransport(body: taxComputationFixture)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        let data = try await client.computeTax(household: household)
        #expect(data.result.engineVersion == 2)
        #expect(data.result.incomeYear == 2025)
        #expect(data.result.totals.totalPIT == Decimal(string: "10994.5175"))
        #expect(data.result.csss.total == Decimal(string: "343.15719"))
        #expect(data.calculation.totalPIT == data.result.totals.totalPIT)
        #expect(data.result.partners.first?.taxableIncome == 37535)
        let request = try #require(await transport.requests.first)
        #expect(request.method == .post)
        #expect(request.url.path == "/api/belgian-tax/compute")
        let body = try JSONDecoder().decode(JSONValue.self, from: #require(request.body))
        let expected = try JSONDecoder().decode(JSONValue.self, from: Data(taxHouseholdFixture.utf8))
        #expect(body == .object(["household": expected]))
    }

    @Test func incompleteComputationIsAContractFailureInsteadOfZeroTax() async throws {
        let household = try JSONDecoder().decode(
            OpenAPI.BelgianTaxHouseholdInput.self, from: Data(taxHouseholdFixture.utf8))
        let transport = TaxFixtureTransport(body: #"{"ok":true,"data":{"result":{},"calculation":{}}}"#)
        let client = APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
        do {
            _ = try await client.computeTax(household: household)
            Issue.record("Incomplete results must not appear as a zero-tax success")
        } catch let error as APIError {
            guard case .contract = error else {
                Issue.record("Expected contract error")
                return
            }
        }
    }
}

@MainActor
@Suite("Native Tax year selection")
struct TaxOverviewModelTests {
    @Test func freshLoadsReuseTheSameYearAndInvalidationRefreshesIt() async {
        let service = TaxOverviewFixtureService()
        let date = Date(timeIntervalSince1970: 100)
        let model = TaxOverviewModel(service: service, now: { date })
        await model.load(year: 2025)
        await model.load(year: 2025)
        #expect(await service.years.count == 1)
        model.invalidate()
        await model.load(year: 2025)
        #expect(await service.years.count == 2)
    }

    @Test func failedYearChangeCannotDisplayThePreviousYearsAmounts() async {
        let service = TaxOverviewFixtureService()
        let model = TaxOverviewModel(service: service)
        await model.load(year: 2025)
        #expect(model.overview?.year == 2025)
        await service.fail()
        await model.load(year: 2024)
        #expect(model.overview == nil)
        #expect(model.error != nil)
        #expect(!model.isFetching)
    }

    @Test func sameYearFailureKeepsThePriorSnapshotAndReportsTheFailure() async {
        let service = TaxOverviewFixtureService()
        let model = TaxOverviewModel(service: service)
        await model.load(year: 2025)
        await service.fail()
        await model.load(year: 2025, force: true)
        #expect(model.overview?.year == 2025)
        #expect(model.error != nil)
    }

    @Test func lateResponseFromAnOlderYearCannotReplaceTheSelectedYear() async {
        let service = TaxOverviewFixtureService()
        await service.pauseFirst()
        let model = TaxOverviewModel(service: service)
        let old = Task { await model.load(year: 2025) }
        await service.waitForPause()
        await model.load(year: 2024)
        #expect(model.overview?.year == 2024)
        await service.release()
        await old.value
        #expect(model.overview?.year == 2024)
        #expect(!model.isFetching)
    }
}

private func taxOverviewFixture(year: Int, frozen: Bool = false) throws -> OpenAPI.BelgianTaxOverview {
    let engine = try JSONDecoder().decode(JSONValue.self, from: Data(taxComputationFixture.utf8))["data"]!
    var household = try JSONDecoder().decode(JSONValue.self, from: Data(taxHouseholdFixture.utf8)).objectValue!
    household["taxYear"] = .int(year)
    let value: JSONValue = .object([
        "year": .int(year), "liveYear": .int(2025), "isHistorical": .bool(year != 2025),
        "hasSnapshot": .bool(false), "hasProfile": .bool(true),
        "household": .object(household), "liveHousehold": .object(household), "householdSnapshots": .object([:]),
        "snapshotMetas": .object([:]), "metadata": .object([:]),
        "calculation": frozen ? .object(["totalPIT": .double(123.4567)]) : engine["calculation"]!,
        "result": engine["result"]!, "calculationSource": .string(frozen ? "frozen" : "computed"),
        "householdResultSource": .string("computed"), "householdMigrationNeeded": .bool(false),
        "snapshotsMigrationNeeded": .bool(false), "storedValueInvalid": .bool(false),
        "warnings": .array([]), "records": .array([]),
    ])
    return try JSONDecoder().decode(OpenAPI.BelgianTaxOverview.self, from: APIBody.encode(value))
}

private actor TaxOverviewFixtureService: TaxComputationService {
    var years: [Int?] = []
    private var fails = false
    private var paused = false
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    func fail() { fails = true }
    func pauseFirst() { paused = true }
    func waitForPause() async {
        if held != nil { return }
        await withCheckedContinuation { entered = $0 }
    }
    func release() {
        held?.resume()
        held = nil
    }
    func computeTax(household: OpenAPI.BelgianTaxHouseholdInput) async throws -> OpenAPI.BelgianTaxComputation {
        throw APIError.invalidRequest("Unused fixture operation")
    }
    func taxOverview(year: Int?) async throws -> OpenAPI.BelgianTaxOverview {
        years.append(year)
        if paused, years.count == 1 {
            await withCheckedContinuation { continuation in
                held = continuation
                entered?.resume()
                entered = nil
            }
        }
        if fails { throw APIError.network("Synthetic fixture failure") }
        return try taxOverviewFixture(year: year ?? 2025)
    }
}

private actor TaxFixtureTransport: APITransport {
    let body: String
    var requests: [APIRequest] = []
    init(body: String) { self.body = body }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        return APIResponse(status: 200, body: Data(body.utf8))
    }
}

// Synthetic SC-01 household and the backend's wire result; figures are checked against
// the hand-derived scenario, not calculated in Swift.
private let taxHouseholdFixture = #"""
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
private let taxComputationFixture = #"""
    {
      "ok": true,
      "data": {
        "result": {
          "engineVersion": 2,
          "incomeYear": 2025,
          "assessment": {
            "mode": "single",
            "reason": "one_partner",
            "legalBasis": "WIB 92 art. 126 §1",
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
              "bracket": "€0 – €16320"
            },
            {
              "label": "Bracket 2 (40%)",
              "bracketNumber": 2,
              "amount": -4992,
              "rate": 40,
              "bracket": "€16320 – €28800"
            },
            {
              "label": "Bracket 3 (45%)",
              "bracketNumber": 3,
              "amount": -3930.75,
              "rate": 45,
              "bracket": "€28800 – €49840"
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
    }
    """#
