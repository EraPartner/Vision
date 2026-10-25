import Foundation
import Testing

@testable import VisionNativeCore

@MainActor
@Suite("Native Tax screen coordination")
struct TaxScreensTests {
    @Test func historicalOverviewKeepsLiveEditorAndDeductionYearsIndependent() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await screens.load(year: 2024, currency: "EUR")
        #expect(screens.overview.overview?.year == 2024)
        #expect(screens.dashboard.data?.year == 2024)
        #expect(screens.deductions.data?.year == 2025)
        await screens.openLiveProfile(initialStep: .exemptions)
        #expect(screens.profile.isPresented)
        #expect(screens.profile.year == 2025)
        #expect(!screens.profile.editingHistorical)
        #expect(screens.profile.step == .exemptions)
        #expect(screens.overview.overview?.year == 2024)
        #expect(screens.dashboard.data?.year == 2024)
        #expect(await screens.profile.close())
        #expect(await transport.writes.isEmpty)
    }

    @Test func unfilingTheEditorYearCannotUnfileTheDifferentOverviewYear() async throws {
        let transport = try TaxScreenTransport()
        let client = screenClient(transport)
        let screens = TaxScreens(client: client)
        await screens.load(year: 2024, currency: "EUR")
        screens.profile.begin(overview: try await client.taxOverview(year: 2023))
        #expect(screens.profile.isFiled)
        #expect(await screens.unfileProfileYear())
        #expect(!screens.profile.isFiled)
        #expect(screens.profile.year == 2023)
        #expect(screens.overview.overview?.year == 2024)
        let metadata = await transport.settings[TaxYearMutation.metadataKey]
        #expect(metadata?["2023"]?["filing"] == nil)
        #expect(metadata?["2024"]?["filing"] != nil)
        #expect(metadata?["2023"]?["frozenCalculation"]?["totalPIT"] == .number(123))
        #expect(metadata?["2023"]?["history"]?.arrayValue?.last?["kind"] == .string("unfiled"))
        #expect(await screens.profile.close())
    }

    @Test func delayedOldExclusionReadCannotReplaceTheNewYearAndCurrency() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await transport.pauseNextSettingsRead()
        let old = Task { await screens.load(year: 2024, currency: "EUR") }
        await transport.waitForPause()
        await transport.setExcludedCategory(22)
        await screens.load(year: 2023, currency: "USD")
        #expect(screens.dashboard.data?.year == 2023)
        #expect(screens.dashboard.data?.currency == "USD")
        await transport.release()
        await old.value
        #expect(screens.overview.overview?.year == 2023)
        #expect(screens.dashboard.data?.year == 2023)
        #expect(screens.dashboard.data?.currency == "USD")
        let requests = await transport.requests.filter { $0.url.path == "/api/belgian-tax/dashboard" }
        let current = try #require(requests.last)
        #expect(screenQuery(current, "excluded_category_ids") == "22")
    }

    @Test func csvSavesTheViewedFiledYearWithoutSubstitutingComputedPartnerFigures() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await screens.load(year: 2024, currency: "EUR")
        var exported: (Data, String)?
        screens.save = { data, filename in
            exported = (data, filename)
            return true
        }
        await screens.exportYearCsv()
        let file = try #require(exported)
        let text = String(decoding: file.0, as: UTF8.self)
        #expect(file.1 == "vision-tax-2024-filed.csv")
        #expect(text.contains("Income year,2024\n"))
        #expect(text.contains("Currency,EUR\n"))
        #expect(text.contains("Status,filed\n"))
        #expect(text.contains("Total PIT,456\n"))
        #expect(!text.contains("# Per-partner"))
        #expect(screens.exportError == nil)
    }

    @Test func csvRefusesAValidShapedDashboardWithTheWrongCurrency() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await screens.load(year: 2024, currency: "EUR")
        screens.dashboard.invalidate()
        await transport.respondWithWrongCurrency()
        var saves = 0
        screens.save = { _, _ in
            saves += 1
            return true
        }
        await screens.exportYearCsv()
        #expect(saves == 0)
        #expect(screens.exportError != nil)
        #expect(screens.dashboard.data == nil)
        #expect(!screens.isExporting)
    }

    @Test func csvRefusesTheCapturedYearAfterNavigationDuringItsRead() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await screens.load(year: 2024, currency: "EUR")
        screens.dashboard.invalidate()
        await transport.pauseNextSettingsRead()
        var saves = 0
        screens.save = { _, _ in
            saves += 1
            return true
        }
        let export = Task { await screens.exportYearCsv() }
        await transport.waitForPause()
        await screens.load(year: 2023, currency: "USD")
        await transport.release()
        await export.value
        #expect(saves == 0)
        #expect(screens.exportError != nil)
        #expect(screens.overview.overview?.year == 2023)
        #expect(screens.dashboard.data?.year == 2023)
        #expect(screens.dashboard.data?.currency == "USD")
    }

    @Test func deductionLostAcknowledgementRefreshesLiveInputsWithoutChangingHistoricalSnapshots() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await screens.load(year: 2024, currency: "EUR")
        let originalSnapshot = await transport.settings[TaxYearMutation.snapshotsKey]?["2024"]
        let group = try #require(screens.deductions.groups.first)
        await transport.loseNextWriteAcknowledgement()
        await #expect(throws: APIError.self) {
            try await screens.applyDeduction(.init(year: 2025, group: group))
        }
        #expect(screens.overview.overview?.year == 2024)
        #expect(
            screens.overview.overview?.liveHousehold.partners.first?.reductions.charitableDonations
                == Decimal(string: "55.55"))
        #expect(screens.overview.error == nil)
        #expect(screens.dashboard.data == nil)
        #expect(await transport.settings[TaxYearMutation.snapshotsKey]?["2024"] == originalSnapshot)
        let write = try #require(await transport.writes.first)
        #expect(
            Set(write["settings"]?.objectValue?.keys ?? [String: TaxValue]().keys) == [TaxYearMutation.householdKey])
        #expect(write["expected"]?[TaxYearMutation.householdKey]?["exists"] == .bool(true))
    }

    @Test func liveProfileReadRejectsWrongYearBeforeOpeningTheEditor() async throws {
        let transport = try TaxScreenTransport()
        let screens = TaxScreens(client: screenClient(transport))
        await transport.respondToLiveReadWithHistoricalYear()
        await screens.openLiveProfile()
        #expect(!screens.profile.isPresented)
        #expect(screens.profileOpenError != nil)
    }
}

private func screenClient(_ transport: TaxScreenTransport) -> APIClient {
    APIClient(baseURL: { URL(string: "http://127.0.0.1:3100") }, transport: transport, maxRetries: 0)
}
private func screenQuery(_ request: APIRequest, _ name: String) -> String? {
    URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == name }?.value
}

private actor TaxScreenTransport: APITransport {
    var settings: [String: TaxValue]
    var requests: [APIRequest] = []
    var writes: [TaxValue] = []
    private var engine: TaxValue
    private var excludedCategory = 11
    private var wrongCurrency = false
    private var wrongLiveYear = false
    private var loseWrite = false
    private var pauseSettings = false
    private var paused = false
    private var gate: CheckedContinuation<Void, Never>?
    private var waiter: CheckedContinuation<Void, Never>?

    init() throws {
        let live = try JSONDecoder().decode(TaxValue.self, from: Data(screenHouseholdJSON.utf8))
        engine = try JSONDecoder().decode(TaxValue.self, from: Data(screenComputationJSON.utf8))
        var snapshots: TaxValue = .object([:])
        var metadata: TaxValue = .object([:])
        for year in [2023, 2024] {
            var snapshot = live
            snapshot["taxYear"] = .number(Decimal(year))
            snapshots[String(year)] = snapshot
            metadata[String(year)] = .object([
                "filing": .object(["filedAt": .string("2025-03-01T00:00:00Z")]),
                "frozenCalculation": .object(["totalPIT": .number(Decimal(year == 2023 ? 123 : 456))]),
            ])
        }
        settings = [
            TaxYearMutation.householdKey: live, TaxYearMutation.snapshotsKey: snapshots,
            TaxYearMutation.metadataKey: metadata,
        ]
    }
    func pauseNextSettingsRead() {
        pauseSettings = true
        paused = false
    }
    func waitForPause() async {
        if paused { return }
        await withCheckedContinuation { waiter = $0 }
    }
    func release() {
        gate?.resume()
        gate = nil
    }
    func setExcludedCategory(_ id: Int) { excludedCategory = id }
    func respondWithWrongCurrency() { wrongCurrency = true }
    func respondToLiveReadWithHistoricalYear() { wrongLiveYear = true }
    func loseNextWriteAcknowledgement() { loseWrite = true }

    func send(_ request: APIRequest) async throws -> APIResponse {
        requests.append(request)
        let data: TaxValue
        switch request.url.path {
        case "/api/belgian-tax/overview":
            let year = screenQuery(request, "year").flatMap(Int.init) ?? (wrongLiveYear ? 2023 : 2025)
            data = overview(year: year)
        case "/api/belgian-tax/compute":
            data = engine
        case "/api/belgian-tax/dashboard":
            let year = screenQuery(request, "year").flatMap(Int.init) ?? 2025
            let currency = wrongCurrency ? "WRONG" : screenQuery(request, "currency") ?? "EUR"
            data = dashboard(year: year, currency: currency)
        case "/api/settings/dashboard_settings":
            data = setting(
                key: "dashboard_settings",
                value: .object([
                    "exclusionScope": .string("everywhere"), "excludeHiddenCategories": .bool(false),
                    "excludedCategoryIds": .array([.number(Decimal(excludedCategory))]),
                ]))
            if pauseSettings {
                pauseSettings = false
                paused = true
                waiter?.resume()
                waiter = nil
                await withCheckedContinuation { gate = $0 }
            }
        case "/api/settings/widget_visibility": data = setting(key: "widget_visibility", value: .object([:]))
        case "/api/info/deduction-candidates":
            let year = screenQuery(request, "year").flatMap(Int.init) ?? 2025
            data = .object([
                "year": .number(Decimal(year)), "from": .string("\(year)-01-01"), "to": .string("\(year)-12-31"),
                "currency": .string("EUR"),
                "byDeductionType": .array([
                    .object([
                        "deductionType": .string("charitableDonations"), "total": .number(Decimal(string: "55.55")!),
                        "categoryCount": .number(1),
                        "categories": .array([
                            .object([
                                "category": .string("Donations"), "total": .number(Decimal(string: "55.55")!),
                                "count": .number(1),
                            ])
                        ]),
                    ])
                ]),
            ])
        case "/api/settings":
            let body = try JSONDecoder().decode(TaxValue.self, from: #require(request.body))
            writes.append(body)
            let changes = body["settings"]?.objectValue ?? [:]
            for (key, value) in changes { settings[key] = value }
            if loseWrite {
                loseWrite = false
                throw APIError.network("Synthetic lost acknowledgement")
            }
            data = .object(["saved": .number(Decimal(changes.count))])
        default: throw APIError.invalidRequest("Unexpected synthetic endpoint: \(request.url.path)")
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
        let meta = metadata[String(year)] ?? .object([:])
        let frozen = meta["frozenCalculation"] != nil
        return .object([
            "year": .number(Decimal(year)), "liveYear": .number(2025), "isHistorical": .bool(year != 2025),
            "hasSnapshot": .bool(snapshots[String(year)] != nil), "hasProfile": .bool(true),
            "householdMigrationNeeded": .bool(false), "snapshotsMigrationNeeded": .bool(false),
            "storedValueInvalid": .bool(false),
            "household": household, "liveHousehold": live, "householdSnapshots": snapshots, "snapshotMetas": metadata,
            "metadata": meta, "calculation": meta["frozenCalculation"] ?? engine["calculation"]!, "result": result,
            "calculationSource": .string(frozen ? "frozen" : "computed"), "householdResultSource": .string("computed"),
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
                "otherTaxableIncome": .number(0),
                "professionalExpenseMethod": .string("lump_sum"), "actualProfessionalExpenses": .number(0),
                "dependentChildren": .number(0), "dependentOtherPersons": .number(0), "isDisabled": .bool(false),
                "isSpouseDisabled": .bool(false),
            ]),
            "exportProfile": .object(["employmentType": .string("employee"), "grossAnnualIncome": .number(50000)]),
            "suggestions": .array([]), "householdBreakdownRows": .array([]), "rules": .array([]),
        ])
    }
}

// Independent synthetic SC-01 fixture for API/coordinator requests.
private let screenHouseholdJSON = #"""
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
private let screenComputationJSON = #"""
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
