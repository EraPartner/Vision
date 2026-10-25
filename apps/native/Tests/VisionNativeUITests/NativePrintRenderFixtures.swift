import Foundation
import VisionNativeCore

// Fully synthetic, already-computed endpoint values. These fixtures do not run fiscal formulas.
enum NativePrintRenderFixtures {
    static let taxOverview = #"""
        {
          "year":2025,
          "liveYear":2025,
          "isHistorical":false,
          "hasSnapshot":true,
          "hasProfile":true,
          "household":{"version":2,"taxYear":2025,"profileConfigured":true,"region":"flanders","communalSurchargePercent":7,"partners":[{"id":"A","isDisabled":false,"activities":[{"id":"act_A_1","kind":"employee","grossIncome":50000}],"professionalExpenses":{},"unionDues":0,"otherTaxableIncome":0,"alimonyPaid":0,"reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":0,"charitableDonations":0,"childcareCosts":0,"medicalExpenses":0}},{"id":"B","isDisabled":false,"activities":[],"professionalExpenses":{},"unionDues":0,"otherTaxableIncome":0,"alimonyPaid":0,"reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":0,"charitableDonations":0,"childcareCosts":0,"medicalExpenses":0}}],"relationship":{"events":[]},"dependents":{"children":0,"otherPersons":0},"home":{"cadastralIncome":0,"mortgageInterestPaid":0}},
          "liveHousehold":{"version":2,"taxYear":2025,"profileConfigured":true,"region":"flanders","communalSurchargePercent":7,"partners":[{"id":"A","isDisabled":false,"activities":[{"id":"act_A_1","kind":"employee","grossIncome":50000}],"professionalExpenses":{},"unionDues":0,"otherTaxableIncome":0,"alimonyPaid":0,"reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":0,"charitableDonations":0,"childcareCosts":0,"medicalExpenses":0}},{"id":"B","isDisabled":false,"activities":[],"professionalExpenses":{},"unionDues":0,"otherTaxableIncome":0,"alimonyPaid":0,"reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":0,"charitableDonations":0,"childcareCosts":0,"medicalExpenses":0}}],"relationship":{"events":[]},"dependents":{"children":0,"otherPersons":0},"home":{"cadastralIncome":0,"mortgageInterestPaid":0}},
          "householdSnapshots":{},
          "snapshotMetas":{},
          "metadata":{"frozenCalculation":{"totalPIT":123.4567}},
          "calculation":{"totalPIT":123.45,"grossIncome":50000,"netTakeHome":49876.55,"effectiveRate":0.25},
          "result":{"engineVersion":2,"incomeYear":2025,"assessment":{"mode":"joint","reason":"one_partner","legalBasis":"WIB 92 art. 126 \u00a71","partnerIds":["A","B"]},"partners":[{"partnerId":"A","activities":[{"activityId":"act_A_1","kind":"employee","forfaitCategory":"remuneration","grossIncome":50000,"employeeSocialSecurity":6535.000000000001,"socialContributionsPaid":0,"professionalExpenses":5930,"netProfessionalIncome":37535}],"categories":[{"category":"remuneration","method":"lump_sum","grossAfterContributions":43465,"professionalExpenses":5930,"unionDuesApplied":0,"netIncome":37535}],"grossIncome":50000,"employeeSocialSecurity":6535.000000000001,"professionalExpenses":5930,"unionDuesApplied":0,"netProfessionalIncome":37535,"otherTaxableIncome":0,"alimonyDeduction":0,"taxableIncomeBeforeQuotient":37535,"quotientAdjustment":0,"taxableIncome":37535,"bracketTax":{"b1":4080,"b2":4992,"b3":3930.75,"b4":0,"total":13002.75},"exemption":{"basic":10910,"disability":0,"dependentSupplements":0,"isolatedParentSupplement":0,"ownTotal":10910,"transferredIn":0,"transferredOut":0,"total":10910,"applied":10910},"exemptionBenefit":2727.5,"pitAfterExemption":10275.25,"reductions":{"pension":0,"lifeInsurance":0,"groupInsurance":0,"donations":0,"childcare":0,"domesticHelp":0,"serviceVouchers":0,"total":0},"ownHomeCreditRegime":"none","ownHomeCredit":0,"pensionReduction":0,"reductionsApplied":0,"federalPITAfterReductions":10275.25,"communalSurcharge":719.2675,"totalPIT":10994.5175,"specialSocialSecurityContribution":343.15719,"csssSubject":true,"dividendWhtReclaim":0,"savingsInterestTax":0,"marginalRate":45},{"partnerId":"B","activities":[],"categories":[],"grossIncome":50000,"employeeSocialSecurity":6535.000000000001,"professionalExpenses":5930,"unionDuesApplied":0,"netProfessionalIncome":37535,"otherTaxableIncome":0,"alimonyDeduction":0,"taxableIncomeBeforeQuotient":37535,"quotientAdjustment":0,"taxableIncome":37535,"bracketTax":{"b1":4080,"b2":4992,"b3":3930.75,"b4":0,"total":13002.75},"exemption":{"basic":10910,"disability":0,"dependentSupplements":0,"isolatedParentSupplement":0,"ownTotal":10910,"transferredIn":0,"transferredOut":0,"total":10910,"applied":10910},"exemptionBenefit":2727.5,"pitAfterExemption":10275.25,"reductions":{"pension":0,"lifeInsurance":0,"groupInsurance":0,"donations":0,"childcare":0,"domesticHelp":0,"serviceVouchers":0,"total":0},"ownHomeCreditRegime":"none","ownHomeCredit":0,"pensionReduction":0,"reductionsApplied":0,"federalPITAfterReductions":10275.25,"communalSurcharge":719.2675,"totalPIT":10994.5175,"specialSocialSecurityContribution":343.15719,"csssSubject":true,"dividendWhtReclaim":0,"savingsInterestTax":0,"marginalRate":45}],"quotient":{"applied":false,"transfer":0,"target":0,"cap":13460,"benefit":0},"csss":{"scale":"single","base":37535,"total":343.15719},"propertyTaxEstimate":0,"totals":{"grossIncome":50000,"employeeSocialSecurity":6535.000000000001,"professionalExpenses":5930,"netProfessionalIncome":37535,"taxableIncome":37535,"federalPITBeforeExemption":13002.75,"personalExemptionBenefit":2727.5,"taxReductions":2727.5,"federalPITAfterReductions":10275.25,"communalSurcharge":719.2675,"totalPIT":10994.5175,"specialSocialSecurityContribution":343.15719,"propertyTaxEstimate":0,"totalTaxBurden":17872.674690000003,"netTakeHome":32127.325309999997,"dividendWhtReclaim":0,"savingsInterestTax":0,"refundableChildCredit":0},"issues":[]},
          "calculationSource":"frozen",
          "householdResultSource":"computed",
          "householdMigrationNeeded":false,
          "snapshotsMigrationNeeded":false,
          "storedValueInvalid":false,
          "warnings":[],
          "records":[]
        }
        """#
    static let taxDashboard = #"""
        {
          "year":2025,
          "currency":"EUR",
          "isHistorical":false,
          "hasIncomeSources":true,
          "hasStatsData":true,
          "isEmpty":false,
          "portfolioTaxesForYear":100,
          "totalTaxIncludingPortfolio":223.45,
          "totalTaxIncludingPropertyEstimate":null,
          "yearlyIncome":[{"year":"2025","income":0.12345678901234568,"estimatedTax":0.02,"netAfterTax":0.10345678901234567,"isApproximated":false}],
          "monthlyIncomeTax":[{"period":"2025-01","income":5000,"estimatedTax":200}],
          "recordedIncomeByPartner":{"A":3500,"B":1500},
          "yearCalculations":[{"year":2025,"calculation":{"totalPIT":0.02},"isFiled":true,"hasFrozenCalculation":true,"isCurrent":true,"hasSnapshot":true,"hasTransactions":true},{"year":2024,"calculation":{"grossIncome":40000,"totalPIT":200,"effectiveRate":0.5,"netTakeHome":39800},"isFiled":true,"hasFrozenCalculation":true,"isCurrent":false,"hasSnapshot":true,"hasTransactions":true}],
          "currentInputs":{"employmentType":"employee","grossAnnualIncome":5000,"otherTaxableIncome":0,"professionalExpenseMethod":"lump_sum","actualProfessionalExpenses":0,"dependentChildren":0,"dependentOtherPersons":0,"isDisabled":false,"isSpouseDisabled":false},
          "exportProfile":{},
          "suggestions":[],
          "householdBreakdownRows":[{"key":"grossIncome","tone":"neutral","partnerAmounts":{"A":25000,"B":25000},"household":50000},{"key":"taxableIncome","tone":"neutral","partnerAmounts":{"A":25000,"B":25000},"household":50000},{"key":"totalPIT","tone":"neutral","partnerAmounts":{"A":25000,"B":25000},"household":50000}],
          "rules":[]
        }
        """#
}

actor PrintStatisticsTransport: APITransport {
    private(set) var requests = 0
    private let pivotAmount: String
    private let categoryName: String
    init(pivotAmount: String = "-250", categoryName: String = "Synthetic Food") {
        self.pivotAmount = pivotAmount
        self.categoryName = categoryName
    }
    func send(_ request: APIRequest) async throws -> APIResponse {
        requests += 1
        let body: String
        switch request.url.path {
        case "/api/settings/dashboard_settings":
            body =
                #"{"key":"dashboard_settings","value":{"excludeHiddenCategories":false},"expected":{"exists":true,"value":{"excludeHiddenCategories":false}}}"#
        case "/api/settings/widget_visibility":
            body = #"{"key":"widget_visibility","value":{},"expected":{"exists":true,"value":{}}}"#
        case "/api/aggregations/monthly-summary":
            let rows = (1...12).map { month in
                "{\"month\":\(month),\"year\":2026,\"period_start\":\"2026-\(String(format: "%02d", month))-01\",\"period_end\":\"2026-\(String(format: "%02d", month))-28\",\"total_income\":1000,\"total_spending\":-250,\"net_amount\":750,\"transaction_count\":2}"
            }
            body = "{\"months\":[" + rows.joined(separator: ",") + "]}"
        case "/api/aggregations/category-pivot":
            let rows = (1...12).map { month in
                "\"2026-\(String(format: "%02d", month))\":[{\"categoryId\":3,\"categoryName\":\"\(categoryName)\",\"categoryPathIds\":[3],\"categoryPathSegments\":[\"\(categoryName)\"],\"total\":\(pivotAmount),\"income\":0,\"expense\":\(pivotAmount),\"transactionCount\":2}]"
            }
            body = "{\"categoryPivot\":{" + rows.joined(separator: ",") + "}}"
        case "/api/aggregations/recipient-insights": body = #"{"topMerchants":[],"monthOverMonth":[]}"#
        case "/api/aggregations/recipient-by-year": body = #"{"recipientsByYear":{}}"#
        default: throw APIError.invalidRequest("Unexpected print fixture request: " + request.url.path)
        }
        // Aggregations nest their payload in `{ data, meta }` inside the transport envelope.
        let data =
            request.url.path.hasPrefix("/api/aggregations/")
            ? "{\"data\":\(body),\"meta\":{\"computedAt\":\"2026-10-18T00:00:00.000Z\",\"source\":\"live\"}}" : body
        return APIResponse(status: 200, body: Data("{\"ok\":true,\"data\":\(data)}".utf8))
    }
}

actor PrintNetWorthService: NetWorthService {
    private(set) var calls = 0
    func netWorth(currency: String, limit: Int?, offset: Int?) async throws -> OpenAPI.NetWorthResponse {
        calls += 1
        var rows: [OpenAPI.NetWorthSnapshot] = []
        for index in 0..<48 {
            let month: Int = index < 24 ? 8 : 9
            let day: Int = index % 24 + 1
            let date: String = String(format: "2026-%02d-%02d", month, day)
            let investments: Decimal = Decimal(900 + index)
            let netWorth: Decimal = Decimal(990 + index)
            let row = OpenAPI.NetWorthSnapshot(
                date: date, liquid: 100, liabilities: 10, investments: investments, netWorth: netWorth)
            rows.append(row)
        }
        let visible: [OpenAPI.NetWorthSnapshot]
        if let limit {
            let reversed: [OpenAPI.NetWorthSnapshot] = Array(rows.reversed())
            let start: Int = offset ?? 0
            visible = Array(reversed.dropFirst(start).prefix(limit))
        } else {
            visible = rows
        }
        return .init(
            unconvertedCurrencies: [],
            current: .init(liquid: 100, liabilities: 10, investments: 947, netWorth: 1037, currency: currency),
            monthlyChange: 24, monthlyChangePercent: 2, snapshots: visible,
            snapshotsTotal: limit == nil ? nil : 48, snapshotsLimit: limit, snapshotsOffset: offset)
    }
    func netWorthByAccount(currency: String) async throws -> OpenAPI.NetWorthByAccountResponse {
        calls += 1
        return .init(currency: currency, rows: [], total: 0, unconvertedAccountIds: [])
    }
    func netWorthPrices() async throws -> [NetWorthInvestmentPrice] {
        calls += 1
        return []
    }
    func refreshNetWorthPrices() async throws -> PortfolioPriceRefresh {
        calls += 1
        throw APIError.invalidRequest("Printing cannot refresh prices")
    }
}
