import Foundation

public struct TaxYearCSVFile: Equatable, Sendable {
    public let filename: String
    public let data: Data
}

/// Serializes server-owned figures. Projection and every tax calculation stay in TypeScript.
public enum TaxYearCSV {
    public static func make(
        overview: OpenAPI.BelgianTaxOverview, profile: TaxValue,
        currency: CurrencyCode, generatedAt: String
    ) throws -> TaxYearCSVFile {
        build(
            year: overview.year, profile: profile, calculation: try TaxValue(encoding: overview.calculation),
            currency: currency, isFiled: overview.metadata["filing"] != nil && overview.metadata["filing"] != .null,
            calculationSource: overview.calculationSource, householdResultSource: overview.householdResultSource,
            generatedAt: generatedAt, household: try TaxValue(encoding: overview.household),
            householdResult: try TaxValue(encoding: overview.result))
    }

    static func build(
        year: Int, profile: TaxValue, calculation: TaxValue, currency: CurrencyCode, isFiled: Bool,
        calculationSource: OpenAPI.BelgianTaxOverview.CalculationSource,
        householdResultSource: OpenAPI.BelgianTaxOverview.HouseholdResultSource, generatedAt: String,
        household: TaxValue? = nil, householdResult: TaxValue? = nil
    ) -> TaxYearCSVFile {
        let frozen = calculationSource == .frozen
        var lines = [
            row([.string("# Vision tax year export")]),
            row([.string("Income year"), .number(Decimal(year))]),
            row([.string("Currency"), .string(currency.rawValue)]),
            row([.string("Status"), .string(isFiled ? "filed" : frozen ? "frozen" : "live")]),
            row([.string("Generated at"), .string(generatedAt)]), "",
            row([.string("# Profile inputs")]), row([.string("Field"), .string("Value")]),
        ]
        // A year frozen before its household result was stored has none to read the assessment from.
        let assessed = frozen && householdResultSource != .frozen ? nil : householdResult
        for (label, key) in profileRows {
            if key == "filingStatus" {
                lines.append(row([.string(label), filingStatus(profile, assessed)]))
            } else {
                lines.append(row([.string(label), coalesce(profile[key], profileDefaults[key])]))
            }
        }
        lines += ["", row([.string("# Calculation")]), row([.string("Component"), .string("Amount (\(currency))")])]
        for (label, key) in calculationRows {
            // Missing legacy figures are unavailable. Never replace them with current-engine
            // calculations or an invented zero in an as-filed export.
            let value = coalesce(calculation[key], !frozen && key == "pensionReduction" ? .number(0) : nil)
            lines.append(row([.string(label), rounded(value)]))
        }
        if !frozen || householdResultSource == .frozen {
            lines += partnerLines(household: household, result: householdResult, currency: currency)
        }
        return TaxYearCSVFile(
            filename: "vision-tax-\(year)\(isFiled ? "-filed" : "").csv",
            data: Data(lines.joined(separator: "\n").utf8))
    }

    private static let profileRows: [(String, String)] = [
        ("Employment type", "employmentType"), ("Gross annual income", "grossAnnualIncome"),
        ("Other taxable income", "otherTaxableIncome"), ("Professional expense method", "professionalExpenseMethod"),
        ("Actual professional expenses", "actualProfessionalExpenses"),
        ("Communal surcharge %", "communalSurchargePercent"),
        ("Region", "region"), ("Filing status", "filingStatus"), ("Dependent children", "dependentChildren"),
        ("Dependent children under 3", "dependentChildrenUnder3"),
        ("Dependent children disabled", "dependentChildrenDisabled"),
        ("Dependent other persons", "dependentOtherPersons"),
        ("Dependent other persons disabled", "dependentOtherPersonsDisabled"),
        ("Taxpayer disabled", "isDisabled"), ("Spouse disabled", "isSpouseDisabled"),
        ("Isolated parent", "isIsolatedParent"),
        ("Spouse professional income", "spouseProfessionalIncome"), ("Cadastral income (own home)", "cadastralIncome"),
        ("Mortgage interest paid", "mortgageInterestPaid"), ("Mortgage capital repaid", "mortgageCapitalRepaid"),
        ("Mortgage start year", "mortgageStartYear"), ("Mortgage region", "mortgageRegion"),
        ("Pension scheme", "pensionScheme"),
        ("Personal pension contributions", "personalPensionContributions"),
        ("Life insurance premiums", "lifeInsurancePremiums"),
        ("Charitable donations", "charitableDonations"), ("Childcare costs", "childcareCosts"),
        ("Childcare eligible days", "childcareEligibleDays"),
        ("Employee group insurance", "employeeGroupInsuranceContributions"),
        ("Union dues", "unionDues"), ("Medical expenses", "medicalExpenses"),
        ("Domestic help costs", "domesticHelpCosts"),
        ("Service vouchers", "serviceVoucherCount"), ("Annual dividend income", "annualDividendIncome"),
        ("Annual savings interest", "annualSavingsInterest"), ("Alimony paid", "alimonyPaid"),
    ]
    private static let profileDefaults: [String: TaxValue] = {
        var values = Dictionary(
            uniqueKeysWithValues: [
                "dependentChildrenUnder3", "dependentChildrenDisabled", "dependentOtherPersonsDisabled",
                "spouseProfessionalIncome",
                "mortgageCapitalRepaid", "childcareEligibleDays", "employeeGroupInsuranceContributions",
                "domesticHelpCosts",
                "serviceVoucherCount", "annualDividendIncome", "annualSavingsInterest",
            ].map { ($0, TaxValue.number(0)) })
        values["isIsolatedParent"] = .bool(false)
        return values
    }()
    /// The export's filing status: the server's assessment of the year when its household result
    /// is known, else the profile's own value (empty for a year without one), as the browser does
    /// not decide the assessment (ADR-217; `filingStatus` in exportTaxYearCsv.ts).
    private static func filingStatus(_ profile: TaxValue, _ result: TaxValue?) -> TaxValue {
        if let mode = result?["assessment"]?["mode"]?.stringValue { return .string(mode == "joint" ? "married_joint" : "single") }
        if let status = profile["filingStatus"]?.stringValue { return .string(status) }
        return .string("")
    }
    private static let calculationRows: [(String, String)] = [
        ("Gross income", "grossIncome"), ("Employee social security", "employeeSocialSecurity"),
        ("Special social security contribution", "specialSocialSecurityContribution"),
        ("Professional expenses", "professionalExpenses"),
        ("Other deductions total", "otherDeductionsTotal"), ("Taxable income", "taxableIncome"),
        ("Federal PIT bracket 1", "federalPITBracket1"), ("Federal PIT bracket 2", "federalPITBracket2"),
        ("Federal PIT bracket 3", "federalPITBracket3"), ("Federal PIT bracket 4", "federalPITBracket4"),
        ("Federal PIT before exemption", "federalPITBeforeExemption"),
        ("Personal exemption amount", "personalExemptionAmount"),
        ("Personal exemption benefit", "personalExemptionBenefit"), ("Federal tax credits", "federalTaxCredits"),
        ("Pension reduction", "pensionReduction"), ("Own-home credit", "ownHomeCredit"),
        ("Total tax reductions applied", "taxReductions"),
        ("Federal PIT after reductions", "federalPITAfterReductions"), ("Communal surcharge", "communalSurcharge"),
        ("Total PIT", "totalPIT"), ("Property tax estimate", "propertyTaxEstimate"),
        ("Dividend WHT reclaim", "dividendWhtReclaim"),
        ("Savings interest tax", "savingsInterestTax"), ("Marital quotient transfer", "maritalQuotientTransfer"),
        ("Marital quotient benefit", "maritalQuotientBenefit"), ("Service voucher credit", "serviceVoucherCredit"),
        ("Total tax burden", "totalTaxBurden"), ("Effective rate %", "effectiveRate"),
        ("Marginal rate %", "marginalRate"),
        ("Net take home", "netTakeHome"), ("Monthly tax reserve", "monthlyTaxReserve"),
    ]
    private static let partnerResultRows: [(String, [String])] = [
        ("Gross income", ["grossIncome"]), ("Employee social security", ["employeeSocialSecurity"]),
        ("Professional expenses", ["professionalExpenses"]), ("Net professional income", ["netProfessionalIncome"]),
        ("Marital quotient adjustment", ["quotientAdjustment"]), ("Taxable income", ["taxableIncome"]),
        ("Tax-free sum charged", ["exemption", "applied"]), ("Tax after the tax-free sum", ["pitAfterExemption"]),
        ("Pension reduction", ["pensionReduction"]), ("Tax reductions applied", ["reductionsApplied"]),
        ("Communal surcharge", ["communalSurcharge"]), ("Total PIT", ["totalPIT"]),
        ("Special social security contribution", ["specialSocialSecurityContribution"]),
    ]

    private static func partnerLines(household: TaxValue?, result: TaxValue?, currency: CurrencyCode) -> [String] {
        guard let household, let result, let partners = result["partners"]?.arrayValue, partners.count >= 2 else {
            return []
        }
        let ids = partners.map { $0["partnerId"]?.stringValue ?? "" }
        let headings = ids.map { $0 == "A" ? "You" : $0 == "B" ? "Partner" : "" }
        var lines = [
            "", row([.string("# Per-partner inputs")]),
            row([.string("Field")] + headings.map(TaxValue.string) + [.string("Household")]),
        ]
        let inputs = ids.map { id in
            partnerInputRows((household["partners"]?.arrayValue ?? []).first { $0["id"]?.stringValue == id })
        }
        for index in inputs[0].indices {
            let values = inputs.map { $0[index].1 }
            lines.append(row([.string(inputs[0][index].0)] + values.map(rounded) + [rounded(total(values))]))
        }
        lines += [
            "", row([.string("# Per-partner calculation")]),
            row(
                [.string("Component")] + headings.map { .string("\($0) (\(currency))") } + [
                    .string("Household (\(currency))")
                ]),
        ]
        for (label, path) in partnerResultRows {
            let values = partners.map { read($0, path: path) }
            lines.append(row([.string(label)] + values.map(rounded) + [rounded(total(values))]))
        }
        let assessment = result["assessment"]
        let quotient = result["quotient"]
        lines += [
            "", row([.string("# Assessment")]), row([.string("Assessment mode"), assessment?["mode"]]),
            row([.string("Legal basis"), assessment?["legalBasis"]]),
        ]
        if assessment?["mode"]?.stringValue == "joint" {
            lines.append(row([.string("Marital quotient applied"), quotient?["applied"]]))
            if quotient?["applied"]?.boolValue == true, let from = quotient?["fromPartnerId"]?.stringValue,
                let to = quotient?["toPartnerId"]?.stringValue
            {
                lines.append(
                    row([
                        .string("Marital quotient transfer"), rounded(quotient?["transfer"]),
                        .string(from == "A" ? "You" : "Partner"), .string(to == "A" ? "You" : "Partner"),
                    ]))
                lines.append(row([.string("Marital quotient benefit"), rounded(quotient?["benefit"])]))
            }
        }
        return lines
    }

    private static func partnerInputRows(_ partner: TaxValue?) -> [(String, TaxValue?)] {
        guard let partner else {
            return partnerInputRows(.object([:])).map { ($0.0, nil) }
        }
        let activities = partner["activities"]?.arrayValue
        let amounts = activities?.map { activity in
            activity["kind"]?.stringValue == "net_professional_amount"
                ? coalesce(activity["netProfessionalIncome"], .number(0)) : activity["grossIncome"]
        }
        let reductions = partner["reductions"]
        return [
            ("Gross activity income", amounts.flatMap(total)),
            ("Income activities", activities.map { .number(Decimal($0.count)) }),
            ("Other taxable income", partner["otherTaxableIncome"]), ("Alimony paid", partner["alimonyPaid"]),
            ("Union dues", partner["unionDues"]),
            ("Personal pension contributions", reductions?["personalPensionContributions"]),
            ("Life insurance premiums", reductions?["lifeInsurancePremiums"]),
            ("Employee group insurance", coalesce(reductions?["employeeGroupInsuranceContributions"], .number(0))),
            ("Charitable donations", reductions?["charitableDonations"]),
            ("Childcare costs", reductions?["childcareCosts"]),
            ("Domestic help costs", coalesce(reductions?["domesticHelpCosts"], .number(0))),
        ]
    }
    private static func read(_ value: TaxValue, path: [String]) -> TaxValue? {
        path.reduce(Optional(value)) { $0?[$1] }
    }
    private static func coalesce(_ value: TaxValue?, _ fallback: TaxValue?) -> TaxValue? {
        value == .null ? fallback : value ?? fallback
    }
    private static func total(_ values: [TaxValue?]) -> TaxValue? {
        let numbers = values.compactMap { $0?.decimalValue }
        guard numbers.count == values.count, numbers.allSatisfy({ !$0.isNaN }) else { return nil }
        return .number(numbers.reduce(0, +))
    }
    private static func rounded(_ value: TaxValue?) -> TaxValue? {
        guard var number = value?.decimalValue, !number.isNaN else { return nil }
        var result = Decimal()
        NSDecimalRound(&result, &number, 2, .plain)
        return .number(result)
    }
    private static func row(_ cells: [TaxValue?]) -> String { cells.map(escape).joined(separator: ",") }
    static func escape(_ value: TaxValue?) -> String {
        let text: String
        let isString: Bool
        switch value {
        case .string(let string):
            text = string
            isString = true
        case .number(let number):
            text = number.isNaN ? "" : NSDecimalNumber(decimal: number).stringValue
            isString = false
        case .bool(let bool):
            text = bool ? "true" : "false"
            isString = false
        default: return ""
        }
        let inspected = text.drop { $0 == " " || $0 == "\u{00a0}" }
        let dangerous = inspected.first.map { ["=", "+", "-", "@", "\t", "\r"].contains(String($0)) } ?? false
        let safe = isString && dangerous ? "'" + text : text
        if safe.contains(",") || safe.contains("\"") || safe.contains("\n") || safe.contains("\r") {
            return "\"" + safe.replacingOccurrences(of: "\"", with: "\"\"") + "\""
        }
        return safe
    }
}
