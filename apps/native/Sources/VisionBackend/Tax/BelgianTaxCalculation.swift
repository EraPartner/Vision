import Foundation

/// The flat calculation the screens and reports read (`BelgianTaxCalculation`), as its JSON.
enum BelgianTaxCalculation {
    private static func isIncomeLine(_ partner: PartnerTaxResult) -> Bool {
        partner.partnerID == .a || partner.activities.contains { $0.kind != .netProfessionalAmount }
            || partner.otherTaxableIncome > 0 || partner.alimonyDeduction > 0
    }

    private static func row(
        _ label: String, _ amount: Double, rate: Double? = nil, bracket: String? = nil, bracketNumber: Int? = nil
    ) -> JSValue {
        TaxJSON.object([
            ("label", .string(label)), ("bracketNumber", bracketNumber.map(JSValue.int)),
            ("amount", TaxJSON.number(amount)), ("rate", rate.map(TaxJSON.number)), ("bracket", bracket.map(JSValue.string)),
        ])
    }

    /// `toBelgianTaxCalculation(result, household)`.
    static func json(_ result: HouseholdTaxResult, _ household: TaxHousehold) -> JSValue {
        let number = TaxJSON.number
        let text = JavaScriptNumber.text
        let table = BelgianTaxTable.table(for: result.incomeYear)
        let all = result.partners
        let lines = all.filter(isIncomeLine)
        var gross = 0.0
        for partner in lines { gross += partner.grossIncome + partner.otherTaxableIncome }
        var spouseIncome = 0.0
        for partner in all where !isIncomeLine(partner) {
            spouseIncome += TaxMath.sum(partner.activities, \.netProfessionalIncome) + partner.otherTaxableIncome
        }
        let householdGross = gross + spouseIncome
        let employeeSS = TaxMath.sum(all, \.employeeSocialSecurity)
        let netAfterSS = gross - employeeSS
        let expenses = TaxMath.sum(all, \.professionalExpenses)
        let otherDeductions = TaxMath.sum(all, \.alimonyDeduction)
        let unionDues = TaxMath.sum(all, \.unionDuesApplied)
        let lineTaxable = lines.map { partner -> Double in
            let netAmount = TaxMath.sum(
                partner.activities.filter { $0.kind == .netProfessionalAmount }, \.netProfessionalIncome)
            return netAmount > 0
                ? TaxMath.clampAtZero(
                    partner.netProfessionalIncome - netAmount + partner.otherTaxableIncome - partner.alimonyDeduction)
                : partner.taxableIncomeBeforeQuotient
        }
        let taxableIncome = TaxMath.sum(lineTaxable) { $0 }
        let bracketTax = all.reduce(BracketTax()) { $0 + $1.bracketTax }
        let exemptionBenefit = TaxMath.sum(all, \.exemptionBenefit)
        let appliedCredits = TaxMath.sum(all, \.reductionsApplied)
        let pensionReduction = TaxMath.sum(all, \.pensionReduction)
        let ownHomeCredit = TaxMath.sum(all, \.ownHomeCredit)
        let regime = all.first { $0.ownHomeCreditRegime != .none }?.ownHomeCreditRegime ?? .none
        let serviceVouchers = TaxMath.sum(all) { $0.reductions.serviceVouchers }
        let federalAfter = TaxMath.sum(all, \.federalPITAfterReductions)
        let communal = TaxMath.sum(all, \.communalSurcharge)
        let specialSS = result.csss.total
        let propertyTax = result.propertyTaxEstimate
        let totalPIT = federalAfter + communal
        let burden = totalPIT + employeeSS + specialSS + propertyTax
        let effectiveRate = householdGross > 0 ? (burden / householdGross) * 100 : 0
        var marginalRate = table.brackets[0].rate * 100
        for taxable in lineTaxable {
            marginalRate = TaxMath.max(marginalRate, PersonalIncomeTax.marginalRate(taxable, table.brackets))
        }
        let netTakeHome = householdGross - burden
        let quotientTransfer = result.quotient.applied ? result.quotient.transfer : 0
        let quotientBenefit = result.quotient.applied ? result.quotient.benefit : 0
        let credits = all.reduce(PersonalIncomeTax.AppliedCredits()) { sum, partner in
            sum
                + PersonalIncomeTax.splitAppliedCredits(
                    partner.reductionsApplied, pension: partner.pensionReduction,
                    reductionsTotal: partner.reductions.total, serviceVouchers: partner.reductions.serviceVouchers,
                    ownHome: partner.ownHomeCredit)
        }

        // `buildCalculationBreakdown`
        var breakdown: [JSValue] = [row("Gross Income", gross)]
        if spouseIncome > 0 { breakdown.append(row("Spouse professional income", spouseIncome)) }
        breakdown.append(row("Employee Social Security", -employeeSS, rate: table.employeeSSRate * 100))
        breakdown.append(row("Net after Social Security", netAfterSS))
        breakdown.append(row("Professional Expenses Deduction", -expenses))
        if household.partners.contains(where: { TaxMath.isNonZero($0.alimonyPaid) }) {
            let percent = text(JavaScriptNumber.round(table.alimonyDeductibleFraction * 100))
            breakdown.append(row("Alimony paid (\(percent)% deductible)", -otherDeductions))
        }
        if unionDues > 0 {
            breakdown.append(row("Union dues (within actual professional expenses)", -unionDues))
        }
        breakdown.append(row("Taxable Income", taxableIncome))
        for (index, bracket) in table.brackets.enumerated() {
            let amount = index < 4 ? bracketTax.bands[index] : .nan
            if amount <= 0 { continue }
            let isTop = index == table.brackets.count - 1
            breakdown.append(
                row(
                    "Bracket \(index + 1) (\(text(bracket.rate * 100))%)", -amount, rate: bracket.rate * 100,
                    bracket: isTop ? "€\(text(bracket.from))+" : "€\(text(bracket.from)) – €\(text(bracket.to))",
                    bracketNumber: index + 1))
        }
        if quotientTransfer > 0 { breakdown.append(row("Marital quotient transferred to spouse", -quotientTransfer)) }
        if quotientBenefit > 0 { breakdown.append(row("Marital quotient tax saving", -quotientBenefit)) }
        if exemptionBenefit > 0 { breakdown.append(row("Personal exemption benefit", -exemptionBenefit)) }
        if credits.pension > 0 { breakdown.append(row("Pension reduction (arts 147-153)", -credits.pension)) }
        if credits.serviceVouchers > 0 {
            breakdown.append(row("Service-voucher credit (dienstencheques)", -credits.serviceVouchers))
        }
        if credits.otherReductions > 0 { breakdown.append(row("Other tax reductions", -credits.otherReductions)) }
        if credits.ownHome > 0 { breakdown.append(row("Own-home credit", -credits.ownHome)) }
        breakdown.append(row("Federal PIT (before exemption)", -bracketTax.total))
        breakdown.append(row("Federal PIT (after credits)", -federalAfter))
        let surcharge = household.communalSurchargePercent
        breakdown.append(row("Communal Surcharge (\(text(surcharge))%)", -communal, rate: surcharge))
        if specialSS > 0 { breakdown.append(row("Special Social Security Contribution", -specialSS)) }
        if propertyTax > 0 { breakdown.append(row("Property Tax (estimate)", -propertyTax)) }
        breakdown.append(row("Net Take-Home", netTakeHome))

        let deductions = TaxJSON.object([
            ("alimonyPaid", number(otherDeductions)), ("personalPensionContributions", .int(0)),
            ("lifeInsurancePremiums", .int(0)),
            ("mortgageInterestPaid", number(TaxMath.amount(household.home.mortgageInterestPaid))),
            ("charitableDonations", .int(0)), ("childcareCosts", .int(0)), ("unionDues", number(unionDues)),
            ("medicalExpenses", .int(0)),
        ])
        return TaxJSON.object([
            ("grossIncome", number(gross)), ("spouseProfessionalIncome", number(spouseIncome)),
            ("householdGrossIncome", number(householdGross)), ("employeeSocialSecurity", number(employeeSS)),
            ("specialSocialSecurityContribution", number(specialSS)),
            ("personalExemptionAmount", number(TaxMath.sum(lines) { $0.exemption.ownTotal })),
            ("netIncomeAfterSS", number(netAfterSS)), ("professionalExpenses", number(expenses)),
            ("otherDeductionsTotal", number(otherDeductions)), ("deductions", deductions),
            ("taxableIncome", number(taxableIncome)), ("federalPITBracket1", number(bracketTax.b1)),
            ("federalPITBracket2", number(bracketTax.b2)), ("federalPITBracket3", number(bracketTax.b3)),
            ("federalPITBracket4", number(bracketTax.b4)), ("federalPITBeforeExemption", number(bracketTax.total)),
            ("personalExemptionBenefit", number(exemptionBenefit)), ("federalTaxCredits", number(appliedCredits)),
            ("ownHomeCreditRegime", .string(regime.rawValue)), ("ownHomeCredit", number(ownHomeCredit)),
            ("taxReductions", number(exemptionBenefit + appliedCredits)), ("pensionReduction", number(pensionReduction)),
            ("federalPITAfterReductions", number(federalAfter)), ("communalSurcharge", number(communal)),
            ("totalPIT", number(totalPIT)), ("totalTaxBurden", number(burden)), ("effectiveRate", number(effectiveRate)),
            ("marginalRate", number(marginalRate)), ("netTakeHome", number(netTakeHome)),
            ("monthlyTaxReserve", number(totalPIT / 12)), ("propertyTaxEstimate", number(propertyTax)),
            ("dividendWhtReclaim", number(TaxMath.sum(all, \.dividendWhtReclaim))),
            ("savingsInterestTax", number(TaxMath.sum(all, \.savingsInterestTax))),
            ("maritalQuotientTransfer", number(quotientTransfer)), ("maritalQuotientBenefit", number(quotientBenefit)),
            ("serviceVoucherCredit", number(serviceVouchers)), ("breakdown", .array(breakdown)),
        ])
    }
}
