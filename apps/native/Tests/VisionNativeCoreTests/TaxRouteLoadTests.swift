import Foundation
import Testing

@testable import VisionNativeCore

@MainActor @Suite("Tax route loading and dependent read races")
struct TaxRouteLoadTests {
    @Test func malformedYearCanonicalizesTheLiveYearPreservingOtherQueryItems() async throws {
        let transport = try TaxRouteTransport()
        let screens = TaxScreens(client: routeClient(transport))
        let requested = try #require(NativeRoute("/portfolio/tax?year=2024oops&keep=a%2Bb&keep=c"))
        let canonical = try #require(await screens.loadRoute(route: requested, currency: "EUR"))
        #expect(canonical.string == "/portfolio/tax?year=2025&keep=a%2Bb&keep=c")
        #expect(screens.dashboard.error == nil)
        #expect(screens.overview.overview?.year == 2025 && screens.dashboard.data?.year == 2025)
        #expect(screens.routeLoadError == nil && screens.overview.error == nil)
    }
    @Test func storedOldSnapshotIsAcceptedOutsideTheLiveYearWindow() async throws {
        let transport = try TaxRouteTransport()
        let screens = TaxScreens(client: routeClient(transport))
        let requested = try #require(NativeRoute("/tax?year=1980&keep=x"))
        #expect(await screens.loadRoute(route: requested, currency: "EUR") == requested)
        #expect(screens.overview.overview?.year == 1980 && screens.overview.overview?.hasSnapshot == true)
        #expect(screens.dashboard.data?.year == 1980 && screens.deductions.data?.year == 2025)
    }
    @Test func lateLiveProbeCannotReturnAnOlderCanonicalRouteOrReplaceNewData() async throws {
        let transport = try TaxRouteTransport()
        let screens = TaxScreens(client: routeClient(transport))
        await transport.pauseOverview(year: nil)
        let oldRoute = try #require(NativeRoute("/tax?year=2024&old=1"))
        let old = Task { await screens.loadRoute(route: oldRoute, currency: "EUR") }
        await transport.waitForPause()
        let current = try #require(NativeRoute("/portfolio/tax?year=2023&new=1"))
        #expect(await screens.loadRoute(route: current, currency: "USD") == current)
        await transport.release()
        #expect(await old.value == nil)
        #expect(screens.overview.overview?.year == 2023)
        #expect(screens.dashboard.data?.year == 2023 && screens.dashboard.data?.currency == "USD")
        #expect(screens.routeLoadError == nil)
    }
    @Test func newProbeFailureInvalidatesAnAlreadyRunningOldSelectedYearRead() async throws {
        let transport = try TaxRouteTransport()
        let screens = TaxScreens(client: routeClient(transport))
        await transport.pauseOverview(year: 2024)
        let oldRoute = try #require(NativeRoute("/tax?year=2024"))
        let old = Task { await screens.loadRoute(route: oldRoute, currency: "EUR") }
        await transport.waitForPause()
        await transport.failLiveProbe()
        let current = try #require(NativeRoute("/tax?year=2023"))
        #expect(await screens.loadRoute(route: current, currency: "USD") == nil)
        let newError = try #require(screens.routeLoadError)
        await transport.release()
        #expect(await old.value == nil)
        #expect(screens.routeLoadError == newError)
        #expect(screens.overview.overview?.year != 2024)
        #expect(screens.dashboard.data?.year != 2024)
    }
}

private func routeClient(_ transport: TaxRouteTransport) -> APIClient {
    APIClient(baseURL: { URL(string: "http://127.0.0.1:3002") }, transport: transport, maxRetries: 0)
}
private func routeQuery(_ request: APIRequest, _ name: String) -> String? {
    URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
}
private actor TaxRouteTransport: APITransport {
    private var settings: [String: TaxValue]
    private let engine: TaxValue
    private var failure = false
    private var pausedYear: Int?
    private var shouldPause = false
    private var held: CheckedContinuation<Void, Never>?
    private var entered: CheckedContinuation<Void, Never>?
    init() throws {
        let live = try JSONDecoder().decode(TaxValue.self, from: Data(routeHouseholdJSON.utf8))
        engine = try JSONDecoder().decode(TaxValue.self, from: Data(routeComputationJSON.utf8))
        var snapshots: TaxValue = .object([:])
        for year in [1980, 2023, 2024] {
            var value = live
            value["taxYear"] = .number(Decimal(year))
            snapshots[String(year)] = value
        }
        settings = [
            TaxYearMutation.householdKey: live, TaxYearMutation.snapshotsKey: snapshots,
            TaxYearMutation.metadataKey: .object([:]),
        ]
    }
    func pauseOverview(year: Int?) {
        pausedYear = year
        shouldPause = true
    }
    func waitForPause() async { if held == nil { await withCheckedContinuation { entered = $0 } } }
    func release() {
        held?.resume()
        held = nil
    }
    func failLiveProbe() { failure = true }
    func send(_ request: APIRequest) async throws -> APIResponse {
        let data: TaxValue
        switch request.url.path {
        case "/api/belgian-tax/overview":
            let requested = routeQuery(request, "year").flatMap(Int.init)
            if requested == nil && failure { throw APIError.network("Synthetic newer live probe failure") }
            data = overview(year: requested ?? 2025)
            if shouldPause && requested == pausedYear {
                shouldPause = false
                await withCheckedContinuation {
                    held = $0
                    entered?.resume()
                    entered = nil
                }
            }
        case "/api/belgian-tax/dashboard":
            data = dashboard(
                year: routeQuery(request, "year").flatMap(Int.init) ?? 2025,
                currency: routeQuery(request, "currency") ?? "EUR")
        case "/api/settings/dashboard_settings":
            data = setting(
                key: "dashboard_settings",
                value: .object([
                    "exclusionScope": .string("everywhere"), "excludeHiddenCategories": .bool(false),
                    "excludedCategoryIds": .array([]),
                ]))
        case "/api/settings/widget_visibility":
            data = setting(key: "widget_visibility", value: .object([:]))
        case "/api/info/deduction-candidates":
            data = .object([
                "year": .number(2025), "from": .string("2025-01-01"), "to": .string("2025-12-31"),
                "currency": .string("EUR"), "byDeductionType": .array([]),
            ])
        default: throw APIError.invalidRequest("Unexpected route fixture request")
        }
        return APIResponse(status: 200, body: try APIBody.encode(TaxValue.object(["ok": .bool(true), "data": data])))
    }
    private func setting(key: String, value: TaxValue) -> TaxValue {
        .object(["key": .string(key), "value": value, "expected": .object(["exists": .bool(true), "value": value])])
    }
    private func overview(year: Int) -> TaxValue {
        let live = settings[TaxYearMutation.householdKey]!
        let snapshots = settings[TaxYearMutation.snapshotsKey]!
        let metadata = settings[TaxYearMutation.metadataKey]!
        var household = snapshots[String(year)] ?? live
        household["taxYear"] = .number(Decimal(year))
        var result = engine["result"]!
        result["incomeYear"] = .number(Decimal(year))
        return .object([
            "year": .number(Decimal(year)), "liveYear": .number(2025), "isHistorical": .bool(year != 2025),
            "hasSnapshot": .bool(snapshots[String(year)] != nil), "hasProfile": .bool(true),
            "householdMigrationNeeded": .bool(false), "snapshotsMigrationNeeded": .bool(false),
            "storedValueInvalid": .bool(false),
            "household": household, "liveHousehold": live, "householdSnapshots": snapshots, "snapshotMetas": metadata,
            "metadata": .object([:]), "calculation": engine["calculation"]!, "result": result,
            "calculationSource": .string("computed"), "householdResultSource": .string("computed"),
            "warnings": .array([]),
            "records": .array(settings.sorted { $0.key < $1.key }.map { setting(key: $0.key, value: $0.value) }),
        ])
    }
    private func dashboard(year: Int, currency: String) -> TaxValue {
        .object([
            "year": .number(Decimal(year)), "currency": .string(currency), "isHistorical": .bool(year != 2025),
            "hasIncomeSources": .bool(true), "hasStatsData": .bool(true), "isEmpty": .bool(false),
            "portfolioTaxesForYear": .number(0), "totalTaxIncludingPortfolio": .number(456),
            "totalTaxIncludingPropertyEstimate": .number(456),
            "yearlyIncome": .array([]), "monthlyIncomeTax": .array([]), "yearCalculations": .array([]),
            "currentInputs": .object([
                "employmentType": .string("employee"), "grossAnnualIncome": .number(50000),
                "otherTaxableIncome": .number(0), "professionalExpenseMethod": .string("lump_sum"),
                "actualProfessionalExpenses": .number(0),
                "dependentChildren": .number(0), "dependentOtherPersons": .number(0), "isDisabled": .bool(false),
                "isSpouseDisabled": .bool(false),
            ]),
            "exportProfile": .object(["employmentType": .string("employee"), "grossAnnualIncome": .number(50000)]),
            "suggestions": .array([]), "householdBreakdownRows": .array([]), "rules": .array([]),
        ])
    }
}

// Independent synthetic SC-01 fixture for API/coordinator requests.
private let routeHouseholdJSON = #"""
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
private let routeComputationJSON = #"""
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
