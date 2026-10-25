import Foundation
import Testing

@testable import VisionNativeCore

@Suite("Native tax year CSV parity")
struct TaxYearCSVTests {
    @Test func singlePartnerExportKeepsTheWebColumnsOrderAndFilename() throws {
        let file = TaxYearCSV.build(
            year: 2025, profile: try value(profileFixture), calculation: try value(calculationFixture),
            currency: "EUR", isFiled: false, calculationSource: .computed, householdResultSource: .computed,
            generatedAt: "2026-10-13T12:00:00.000Z")
        #expect(file.filename == "vision-tax-2025.csv")
        #expect(String(decoding: file.data, as: UTF8.self) == singlePartnerGolden)
        #expect(!file.data.starts(with: [0xef, 0xbb, 0xbf]))
        #expect(file.data.last != 10)
    }

    @Test func sparseFrozenFilingRetainsItsFiguresAndOmitsRecomputedHouseholdDetails() throws {
        let file = TaxYearCSV.build(
            year: 2024, profile: try value(profileFixture),
            calculation: .object(["totalPIT": .number(decimal("123.4567"))]),
            currency: "EUR", isFiled: true, calculationSource: .frozen, householdResultSource: .computed,
            generatedAt: "stamp", household: try value(partnerHousehold), householdResult: try value(partnerResult))
        let csv = String(decoding: file.data, as: UTF8.self)
        #expect(file.filename == "vision-tax-2024-filed.csv")
        #expect(csv.contains("Status,filed\n"))
        #expect(csv.contains("Total PIT,123.46\n"))
        #expect(csv.contains("Gross income,\n"))
        #expect(csv.contains("Pension reduction,\n"))
        #expect(!csv.contains("# Per-partner"))
        #expect(!csv.contains("# Assessment"))
    }

    @Test func frozenHouseholdUsesStoredPartnerOrderInputsAssessmentAndQuotient() throws {
        let file = TaxYearCSV.build(
            year: 2025, profile: try value(profileFixture), calculation: .object(["totalPIT": .number(777)]),
            currency: "EUR", isFiled: false, calculationSource: .frozen, householdResultSource: .frozen,
            generatedAt: "stamp", household: try value(partnerHousehold), householdResult: try value(partnerResult))
        let csv = String(decoding: file.data, as: UTF8.self)
        #expect(file.filename == "vision-tax-2025.csv")
        #expect(csv.contains("Status,frozen\n"))
        #expect(csv.hasSuffix(partnerGolden))
        #expect(csv.contains("Total PIT,777\n"))
        // Missing partner metrics remain unavailable even in the household-total column.
        #expect(csv.contains("Gross income,,,\n"))
    }

    @Test func singleAssessedPartnerDoesNotAddHouseholdSections() throws {
        var result = try value(partnerResult)
        result["partners"] = .array(Array(result["partners"]!.arrayValue!.prefix(1)))
        let file = TaxYearCSV.build(
            year: 2025, profile: try value(profileFixture), calculation: .object(["totalPIT": .number(5)]),
            currency: "EUR", isFiled: false, calculationSource: .computed, householdResultSource: .computed,
            generatedAt: "stamp", household: try value(partnerHousehold), householdResult: result)
        #expect(!String(decoding: file.data, as: UTF8.self).contains("# Per-partner"))
    }

    @Test func optionalInputNullsUseTheWebDefaultsWithoutFillingMissingCalculationMetrics() throws {
        var profile = try value(profileFixture)
        profile["dependentChildrenUnder3"] = .null
        profile["filingStatus"] = .null
        profile["isIsolatedParent"] = .null
        var household = try value(partnerHousehold)
        var partners = household["partners"]!.arrayValue!
        var activities = partners[0]["activities"]!.arrayValue!
        activities[1]["netProfessionalIncome"] = nil
        partners[0]["activities"] = .array(activities)
        household["partners"] = .array(partners)
        let file = TaxYearCSV.build(
            year: 2025, profile: profile, calculation: .object(["totalPIT": .number(5)]),
            currency: "EUR", isFiled: false, calculationSource: .frozen, householdResultSource: .frozen,
            generatedAt: "stamp", household: household, householdResult: try value(partnerResult))
        let csv = String(decoding: file.data, as: UTF8.self)
        #expect(csv.contains("Dependent children under 3,0\n"))
        // The assessed household decides (partnerResult is a joint assessment).
        #expect(csv.contains("Filing status,married_joint\n"))
        #expect(csv.contains("Isolated parent,false\n"))
        #expect(csv.contains("Gross activity income,10000,20000,30000\n"))
        #expect(csv.contains("Pension reduction,\n"))
    }

    @Test func filingStatusFollowsTheServersAssessmentOfTheYear() throws {
        func status(
            _ result: TaxValue?, source: OpenAPI.BelgianTaxOverview.HouseholdResultSource = .computed,
            frozen: Bool = false
        ) throws -> String {
            var profile = try value(profileFixture)
            profile["filingStatus"] = nil
            let file = TaxYearCSV.build(
                year: 2025, profile: profile, calculation: .object(["totalPIT": .number(5)]), currency: "EUR",
                isFiled: false, calculationSource: frozen ? .frozen : .computed, householdResultSource: source,
                generatedAt: "stamp", household: try value(partnerHousehold), householdResult: result)
            let csv = String(decoding: file.data, as: UTF8.self)
            return try #require(csv.split(separator: "\n", omittingEmptySubsequences: false)
                .first { $0.hasPrefix("Filing status,") }.map { String($0) })
        }
        #expect(try status(try value(partnerResult)) == "Filing status,married_joint")
        var separated = try value(partnerResult)
        separated["assessment"] = .object(["mode": .string("separate")])
        #expect(try status(separated) == "Filing status,single")
        // No household result, or a year frozen before it was stored: the browser does not decide.
        #expect(try status(nil) == "Filing status,")
        #expect(try status(try value(partnerResult), source: .computed, frozen: true) == "Filing status,")
        #expect(try status(try value(partnerResult), source: .frozen, frozen: true) == "Filing status,married_joint")
    }

    @Test func stringsHaveTheSameFormulaGuardAndQuotingAsFrontendCsv() {
        let fixtures: [(TaxValue?, String)] = [
            (nil, ""), (.null, ""), (.string("a,b"), "\"a,b\""),
            (.string("he said \"hi\""), "\"he said \"\"hi\"\"\""),
            (.string("line1\nline2"), "\"line1\nline2\""),
            (.string("line1\rline2"), "\"line1\rline2\""),
            (.string("=SUM(A1,B1)"), "\"'=SUM(A1,B1)\""),
            (.string("  +SUM(A1)"), "'  +SUM(A1)"),
            (.string("\u{00a0}@SUM(A1)"), "'\u{00a0}@SUM(A1)"),
            (.string("\t=1+1"), "'\t=1+1"), (.string("\r=1+1"), "\"'\r=1+1\""),
            (.string("-5"), "'-5"), (.number(-5), "-5"), (.bool(true), "true"),
            (.number(65000), "65000"), (.string("   "), "   "),
        ]
        for (cell, expected) in fixtures { #expect(TaxYearCSV.escape(cell) == expected) }
    }

    @Test func monetarySerializationRoundsWithoutBinaryConversionOrNumericStringGuard() throws {
        var profile = try value(profileFixture)
        profile["grossAnnualIncome"] = .number(decimal("123.4567890123456789"))
        let file = TaxYearCSV.build(
            year: 2025, profile: profile,
            calculation: .object(["totalPIT": .number(decimal("2.6754")), "netTakeHome": .number(decimal("-12.3451"))]),
            currency: "EUR", isFiled: false, calculationSource: .frozen, householdResultSource: .computed,
            generatedAt: "stamp")
        let csv = String(decoding: file.data, as: UTF8.self)
        #expect(csv.contains("Gross annual income,123.4567890123456789\n"))
        #expect(csv.contains("Total PIT,2.68\n"))
        #expect(csv.contains("Net take home,-12.35\n"))
    }
}

private func value(_ json: String) throws -> TaxValue { try JSONDecoder().decode(TaxValue.self, from: Data(json.utf8)) }
private func decimal(_ text: String) -> Decimal { Decimal(string: text)! }

private let profileFixture = #"""
    {"employmentType":"employee","grossAnnualIncome":50000,"otherTaxableIncome":12.34,
    "professionalExpenseMethod":"lump_sum","actualProfessionalExpenses":0,"communalSurchargePercent":7,
    "region":"flanders","dependentChildren":1,"dependentOtherPersons":0,"isDisabled":false,"isSpouseDisabled":false,
    "cadastralIncome":500,"mortgageInterestPaid":100,"personalPensionContributions":1050,"lifeInsurancePremiums":0,
    "charitableDonations":40,"childcareCosts":0,"unionDues":100,"medicalExpenses":0,"alimonyPaid":0}
    """#
private let calculationFixture = #"""
    {"grossIncome":50012.34,"employeeSocialSecurity":6535,"specialSocialSecurityContribution":343.15719,
    "professionalExpenses":5750,"otherDeductionsTotal":100,"taxableIncome":37627.34,"federalPITBracket1":3800,
    "federalPITBracket2":4360,"federalPITBracket3":2300,"federalPITBracket4":0,"federalPITBeforeExemption":10460,
    "personalExemptionAmount":10910,"personalExemptionBenefit":2727.5,"federalTaxCredits":0,"ownHomeCredit":0,
    "taxReductions":330.1234,"federalPITAfterReductions":7402.3766,"communalSurcharge":518.166362,"totalPIT":7920.542962,
    "propertyTaxEstimate":345.6789,"dividendWhtReclaim":0,"savingsInterestTax":0,"maritalQuotientTransfer":0,
    "maritalQuotientBenefit":0,"serviceVoucherCredit":0,"totalTaxBurden":14798.700152,"effectiveRate":29.5901,
    "marginalRate":48.15,"netTakeHome":35213.639848,"monthlyTaxReserve":659.34524683}
    """#
private let singlePartnerGolden = """
    # Vision tax year export
    Income year,2025
    Currency,EUR
    Status,live
    Generated at,2026-10-13T12:00:00.000Z

    # Profile inputs
    Field,Value
    Employment type,employee
    Gross annual income,50000
    Other taxable income,12.34
    Professional expense method,lump_sum
    Actual professional expenses,0
    Communal surcharge %,7
    Region,flanders
    Filing status,
    Dependent children,1
    Dependent children under 3,0
    Dependent children disabled,0
    Dependent other persons,0
    Dependent other persons disabled,0
    Taxpayer disabled,false
    Spouse disabled,false
    Isolated parent,false
    Spouse professional income,0
    Cadastral income (own home),500
    Mortgage interest paid,100
    Mortgage capital repaid,0
    Mortgage start year,
    Mortgage region,
    Pension scheme,
    Personal pension contributions,1050
    Life insurance premiums,0
    Charitable donations,40
    Childcare costs,0
    Childcare eligible days,0
    Employee group insurance,0
    Union dues,100
    Medical expenses,0
    Domestic help costs,0
    Service vouchers,0
    Annual dividend income,0
    Annual savings interest,0
    Alimony paid,0

    # Calculation
    Component,Amount (EUR)
    Gross income,50012.34
    Employee social security,6535
    Special social security contribution,343.16
    Professional expenses,5750
    Other deductions total,100
    Taxable income,37627.34
    Federal PIT bracket 1,3800
    Federal PIT bracket 2,4360
    Federal PIT bracket 3,2300
    Federal PIT bracket 4,0
    Federal PIT before exemption,10460
    Personal exemption amount,10910
    Personal exemption benefit,2727.5
    Federal tax credits,0
    Pension reduction,0
    Own-home credit,0
    Total tax reductions applied,330.12
    Federal PIT after reductions,7402.38
    Communal surcharge,518.17
    Total PIT,7920.54
    Property tax estimate,345.68
    Dividend WHT reclaim,0
    Savings interest tax,0
    Marital quotient transfer,0
    Marital quotient benefit,0
    Service voucher credit,0
    Total tax burden,14798.7
    Effective rate %,29.59
    Marginal rate %,48.15
    Net take home,35213.64
    Monthly tax reserve,659.35
    """
private let partnerHousehold = #"""
    {"partners":[
    {"id":"A","activities":[{"kind":"employee","grossIncome":20000},{"kind":"net_professional_amount","grossIncome":999,"netProfessionalIncome":500}],"otherTaxableIncome":10,"alimonyPaid":0,"unionDues":100,"reductions":{"personalPensionContributions":1050,"lifeInsurancePremiums":0,"charitableDonations":40,"childcareCosts":100}},
    {"id":"B","activities":[{"kind":"employee","grossIncome":10000}],"otherTaxableIncome":20,"alimonyPaid":5,"unionDues":50,"reductions":{"personalPensionContributions":0,"lifeInsurancePremiums":100,"employeeGroupInsuranceContributions":25,"charitableDonations":60,"childcareCosts":200,"domesticHelpCosts":50}}]}
    """#
private let partnerResult = #"""
    {"partners":[{"partnerId":"B","totalPIT":222.2251,"quotientAdjustment":100},{"partnerId":"A","totalPIT":111.111,"quotientAdjustment":-100}],
    "assessment":{"mode":"joint","legalBasis":"WIB 92 art. 126 §1"},
    "quotient":{"applied":true,"fromPartnerId":"A","toPartnerId":"B","transfer":100.1251,"benefit":5.256}}
    """#
private let partnerGolden = """
    # Per-partner inputs
    Field,Partner,You,Household
    Gross activity income,10000,20500,30500
    Income activities,1,2,3
    Other taxable income,20,10,30
    Alimony paid,5,0,5
    Union dues,50,100,150
    Personal pension contributions,0,1050,1050
    Life insurance premiums,100,0,100
    Employee group insurance,25,0,25
    Charitable donations,60,40,100
    Childcare costs,200,100,300
    Domestic help costs,50,0,50

    # Per-partner calculation
    Component,Partner (EUR),You (EUR),Household (EUR)
    Gross income,,,
    Employee social security,,,
    Professional expenses,,,
    Net professional income,,,
    Marital quotient adjustment,100,-100,0
    Taxable income,,,
    Tax-free sum charged,,,
    Tax after the tax-free sum,,,
    Pension reduction,,,
    Tax reductions applied,,,
    Communal surcharge,,,
    Total PIT,222.23,111.11,333.34
    Special social security contribution,,,

    # Assessment
    Assessment mode,joint
    Legal basis,WIB 92 art. 126 §1
    Marital quotient applied,true
    Marital quotient transfer,100.13,You,Partner
    Marital quotient benefit,5.26
    """
