import Foundation

/// Tax per progressive band (`BracketTax`).
struct BracketTax: Equatable, Sendable {
    var b1 = 0.0
    var b2 = 0.0
    var b3 = 0.0
    var b4 = 0.0
    var total = 0.0

    var bands: [Double] { [b1, b2, b3, b4] }

    /// `addBracketTax(a, b)`.
    static func + (a: BracketTax, b: BracketTax) -> BracketTax {
        BracketTax(b1: a.b1 + b.b1, b2: a.b2 + b.b2, b3: a.b3 + b.b3, b4: a.b4 + b.b4, total: a.total + b.total)
    }

    var jsonValue: JSValue {
        .object(
            JSObject([
                ("b1", TaxJSON.number(b1)), ("b2", TaxJSON.number(b2)), ("b3", TaxJSON.number(b3)),
                ("b4", TaxJSON.number(b4)), ("total", TaxJSON.number(total)),
            ]))
    }
}

/// How the engine's results are written as JSON: `JSON.stringify` writes a non-finite number
/// as `null`.
enum TaxJSON {
    static func number(_ value: Double) -> JSValue { value.isFinite ? .number(value) : .null }

    /// An object of the pairs that have a value: `JSON.stringify` leaves an `undefined` member out.
    static func object(_ pairs: [(String, JSValue?)]) -> JSValue {
        .object(JSObject(pairs.compactMap { key, value in value.map { (key, $0) } }))
    }
}

/// `TaxReductionBreakdown`.
struct TaxReductionBreakdown: Equatable, Sendable {
    var pension = 0.0
    var lifeInsurance = 0.0
    var groupInsurance = 0.0
    var donations = 0.0
    var childcare = 0.0
    var domesticHelp = 0.0
    var serviceVouchers = 0.0
    var total = 0.0

    var jsonValue: JSValue {
        .object(
            JSObject([
                ("pension", TaxJSON.number(pension)), ("lifeInsurance", TaxJSON.number(lifeInsurance)),
                ("groupInsurance", TaxJSON.number(groupInsurance)), ("donations", TaxJSON.number(donations)),
                ("childcare", TaxJSON.number(childcare)), ("domesticHelp", TaxJSON.number(domesticHelp)),
                ("serviceVouchers", TaxJSON.number(serviceVouchers)), ("total", TaxJSON.number(total)),
            ]))
    }
}

/// The per-person income tax rules (`personPit.ts`): bands, exemption, lump-sum expenses,
/// reductions, the pension reduction and the regional own-home credits.
enum PersonalIncomeTax {
    // MARK: Bands

    /// `computeProgressiveTax(value, brackets)`.
    static func progressiveTax(_ value: Double, _ brackets: [BelgianTaxTable.Bracket]) -> BracketTax {
        var result = BracketTax()
        if value <= 0 { return result }
        func band(_ index: Int) -> Double {
            (TaxMath.min(value, brackets[index].to) - brackets[index].from) * brackets[index].rate
        }
        if value > brackets[0].from { result.b1 = band(0) }
        if value > brackets[1].from { result.b2 = band(1) }
        if value > brackets[2].from { result.b3 = band(2) }
        if value > brackets[3].from { result.b4 = (value - brackets[3].from) * brackets[3].rate }
        result.total = result.b1 + result.b2 + result.b3 + result.b4
        return result
    }

    /// `computeExemptionBenefit(amount, brackets)`: the tax the exempt amount would have borne.
    static func exemptionBenefit(_ amount: Double, _ brackets: [BelgianTaxTable.Bracket]) -> Double {
        if amount <= 0 { return 0 }
        var total = 0.0
        for bracket in brackets {
            if amount <= bracket.from { break }
            total += (TaxMath.min(amount, bracket.to) - bracket.from) * bracket.rate
        }
        return total
    }

    /// `computeMarginalRate(taxableIncome, brackets)`, in percent.
    static func marginalRate(_ taxableIncome: Double, _ brackets: [BelgianTaxTable.Bracket]) -> Double {
        var rate = brackets[0].rate * 100
        for bracket in brackets where taxableIncome > bracket.from { rate = bracket.rate * 100 }
        return rate
    }

    // MARK: Professional expenses

    /// `computeLumpSumForfait(category, gross, table)`.
    static func lumpSumForfait(_ category: ForfaitCategory, _ gross: Double, _ table: BelgianTaxTable) -> Double {
        switch category {
        case .director:
            return TaxMath.min(gross * table.directorProfessionalExpenseRate, table.directorProfessionalExpenseCap)
        case .remuneration, .profits:
            return TaxMath.min(gross * table.employeeProfessionalExpenseRate, table.employeeProfessionalExpenseCap)
        case .helpingSpouse:
            return TaxMath.min(gross * table.helpingSpouseProfessionalExpenseRate, table.selfEmployedFeesExpenseCap)
        case .fees:
            var forfait = 0.0
            for bracket in table.selfEmployedFeesExpenseBrackets {
                if gross <= bracket.from { break }
                forfait += (TaxMath.min(gross, bracket.to) - bracket.from) * bracket.rate
            }
            return TaxMath.min(forfait, table.selfEmployedFeesExpenseCap)
        default:
            return 0
        }
    }

    /// `computeProfessionalExpenseClaim(claim, table)`.
    static func expenseClaim(
        category: ForfaitCategory, grossAfterContributions: Double, method: ExpenseMethod, actualAmount: Double?,
        unionDues: Double, _ table: BelgianTaxTable
    ) -> Double {
        if method == .actual { return TaxMath.amount(actualAmount) + TaxMath.amount(unionDues) }
        return lumpSumForfait(category, grossAfterContributions, table)
    }

    // MARK: Reductions

    /// `computeServiceVoucherCredit(inputs, region, table)`.
    static func serviceVoucherCredit(
        _ inputs: TaxHousehold.Reductions, _ region: BelgianRegion, _ table: BelgianTaxTable
    ) -> Double {
        guard inputs.serviceVoucherEligible, let parameters = table.serviceVoucherRegional[region],
            !(parameters.rate <= 0), !(parameters.spendCap <= 0)
        else { return 0 }
        let spend =
            inputs.serviceVoucherSpend.map { TaxMath.max($0, 0) }
            ?? TaxMath.amount(inputs.serviceVoucherCount) * parameters.voucherPrice
        if spend <= 0 { return 0 }
        return TaxMath.min(spend, parameters.spendCap) * parameters.rate
    }

    /// `qualifyingDonations(inputs, table)`: the gifts that reach the legal minimum.
    static func qualifyingDonations(_ inputs: TaxHousehold.Reductions, _ table: BelgianTaxTable) -> Double {
        let amount = TaxMath.amount(inputs.charitableDonations)
        return inputs.charitableDonationsEligible && amount >= table.charitableDonationMin ? amount : 0
    }

    /// `computeDonationReduction(gifts, netIncome, table)`.
    static func donationReduction(_ gifts: Double, _ netIncome: Double, _ table: BelgianTaxTable) -> Double {
        let eligible = TaxMath.min(
            TaxMath.min(TaxMath.max(gifts, 0), TaxMath.max(netIncome * 0.1, 0)), table.charitableDonationAbsoluteCap)
        return eligible * table.charitableDonationRate
    }

    /// `computeTaxReductions(inputs, region, donationBaseIncome, table)`.
    static func reductions(
        _ inputs: TaxHousehold.Reductions, _ region: BelgianRegion, donationBaseIncome: Double, _ table: BelgianTaxTable
    ) -> TaxReductionBreakdown {
        let pensionCap =
            inputs.alternativePensionScheme ? table.pensionSavingsCapAlternative : table.pensionSavingsCapStandard
        let pensionRate =
            inputs.alternativePensionScheme ? table.pensionSavingsRateAlternative : table.pensionSavingsRateStandard
        var result = TaxReductionBreakdown()
        result.pension =
            inputs.pensionEligible
            ? TaxMath.min(TaxMath.orZero(inputs.personalPensionContributions), pensionCap) * pensionRate : 0
        result.lifeInsurance =
            inputs.lifeInsuranceEligible
            ? TaxMath.min(TaxMath.orZero(inputs.lifeInsurancePremiums), table.lifeInsuranceCap) * table.lifeInsuranceRate
            : 0
        result.groupInsurance =
            inputs.employeeGroupInsuranceEligible
            ? TaxMath.amount(inputs.employeeGroupInsuranceContributions) * table.groupInsuranceRate : 0
        result.donations = donationReduction(qualifyingDonations(inputs, table), donationBaseIncome, table)
        let childcareDayCap = TaxMath.amount(inputs.childcareEligibleDays) * table.childcareDailyCap
        result.childcare =
            inputs.childcareEligible
            ? TaxMath.min(TaxMath.orZero(inputs.childcareCosts), childcareDayCap) * table.childcareRate : 0
        result.domesticHelp =
            inputs.domesticHelpEligible
            ? TaxMath.min(TaxMath.orZero(inputs.domesticHelpCosts), table.domesticHelpCap) * table.domesticHelpRate : 0
        result.serviceVouchers = serviceVoucherCredit(inputs, region, table)
        result.total =
            result.pension + result.lifeInsurance + result.groupInsurance + result.donations + result.childcare
            + result.domesticHelp + result.serviceVouchers
        return result
    }

    /// `isChildcareDeducted(inputs)`.
    static func isChildcareDeducted(_ inputs: TaxHousehold.Reductions) -> Bool {
        inputs.childcareEligible && TaxMath.orZero(inputs.childcareCosts) > 0
            && TaxMath.orZero(inputs.childcareEligibleDays) > 0
    }

    // MARK: Pension reduction (WIB 92 arts 147-153)

    /// `pensionBaseReductionFactor(t, p)`.
    static func pensionBaseFactor(_ taxable: Double, _ parameters: BelgianTaxTable.PensionReduction) -> Double {
        let (lower, upper) = (parameters.baseLimits.lower, parameters.baseLimits.upper)
        if let zero = parameters.baseZeroLimits, taxable > zero.from {
            return taxable > zero.to ? 0 : (zero.to - taxable) / (zero.to - zero.from) / 3
        }
        if taxable >= upper { return 1 / 3 }
        if taxable > lower { return 1 / 3 + ((2 / 3) * (upper - taxable)) / (upper - lower) }
        return 1
    }

    /// `pensionAdditionalReductionFactor(t, p)`.
    static func pensionAdditionalFactor(_ taxable: Double, _ parameters: BelgianTaxTable.PensionReduction) -> Double {
        let (lower, upper) = (parameters.additionalLimits.lower, parameters.additionalLimits.upper)
        if taxable >= upper { return 0 }
        if taxable > lower { return (upper - taxable) / (upper - lower) }
        return 1
    }

    /// `pensionActivityExclusionFraction(grossStatutoryPension, hasSurvivorPension, p)`.
    static func pensionActivityExclusionFraction(
        grossStatutoryPension: Double, hasSurvivorPension: Bool, _ parameters: BelgianTaxTable.PensionReduction
    ) -> Double {
        if hasSurvivorPension { return 1 }
        let limits = parameters.statutoryPensionLimits
        if grossStatutoryPension <= 0 || grossStatutoryPension > limits.upper { return 0 }
        if grossStatutoryPension <= limits.lower { return 1 }
        if limits.difference <= 0 { return 0 }
        return TaxMath.min(TaxMath.max((limits.upper - grossStatutoryPension) / limits.difference, 0), 1)
    }

    /// `computePensionReduction(input, table).total`.
    static func pensionReduction(
        pensionIncome: Double, netIncome: Double, taxableIncome: Double, taxAfterExemption: Double,
        excludedActivityIncome: Double, _ table: BelgianTaxTable
    ) -> Double {
        let pension = TaxMath.max(pensionIncome, 0)
        let net = TaxMath.max(netIncome, 0)
        if pension <= 0 || net <= 0 { return 0 }
        let parameters = table.pensionReduction
        let excluded = TaxMath.min(TaxMath.max(excludedActivityIncome, 0), net)
        let denominator = net - excluded
        let share = denominator > 0 ? TaxMath.min(pension / denominator, 1) : 1
        let taxable = TaxMath.max(taxableIncome, 0)
        let base = parameters.base * share * pensionBaseFactor(taxable, parameters)
        let additional = parameters.additional * share * pensionAdditionalFactor(taxable, parameters)
        let taxShareLimit = TaxMath.max(taxAfterExemption, 0) * TaxMath.min(pension / net, 1)
        return TaxMath.min(base + additional, taxShareLimit)
    }

    // MARK: Own-home credit

    /// `OwnHomeCreditInputs`: the home with the borrower's region and children.
    struct OwnHomeInputs {
        var home: TaxHousehold.Home
        var region: BelgianRegion
        var dependentChildren: Double?
        var dependentChildrenDisabled: Double?
    }

    /// `OwnHomeCreditTaxpayer`.
    struct OwnHomeTaxpayer {
        var taxableIncome: Double
        var marginalRatePercent: Double
        var incomeYear: Double
    }

    /// Children with a disabled child counted twice.
    private static func childCount(_ inputs: OwnHomeInputs) -> Double {
        let children = TaxMath.amount(inputs.dependentChildren)
        let disabled = TaxMath.min(TaxMath.amount(inputs.dependentChildrenDisabled), children)
        return children + disabled
    }

    /// `woonbonusChildCount(inputs)`.
    static func woonbonusChildCount(_ inputs: OwnHomeInputs) -> Double {
        if let atLoanStart = inputs.home.woonbonusChildrenAtLoanStart { return TaxMath.max(atLoanStart, 0) }
        return childCount(inputs)
    }

    /// `resolveMortgageRegime(inputs)`.
    static func mortgageRegime(_ inputs: OwnHomeInputs) -> MortgageCreditRegime {
        guard inputs.home.mortgageIsPrimaryResidence else { return .none }
        if !TaxMath.isNonZero(inputs.home.mortgageInterestPaid), !TaxMath.isNonZero(inputs.home.mortgageCapitalRepaid) {
            return .none
        }
        let startYear = inputs.home.mortgageStartYear ?? 0
        if inputs.region == .flanders, startYear > 0, startYear < 2020 { return .flemishWoonbonus }
        if inputs.region == .wallonia, startYear >= 2016, startYear <= 2024 { return .walloonChequeHabitat }
        return .none
    }

    /// `mortgagePayments(inputs)`: interest and capital.
    static func mortgagePayments(_ home: TaxHousehold.Home) -> Double {
        TaxMath.amount(home.mortgageInterestPaid) + TaxMath.amount(home.mortgageCapitalRepaid)
    }

    /// `woonbonusBasket(inputs, table, taxpayer)`: the basket's cap and rate.
    static func woonbonusBasket(
        _ inputs: OwnHomeInputs, _ table: BelgianTaxTable, _ taxpayer: OwnHomeTaxpayer
    ) -> (cap: Double, rate: Double) {
        let startYear = inputs.home.mortgageStartYear ?? 0
        let loanAge = TaxMath.max(0, taxpayer.incomeYear - startYear)
        var cap: Double
        let rate: Double
        if startYear < 2015 {
            cap = table.flemishWoonbonusBaseCap
            rate = TaxMath.max(taxpayer.marginalRatePercent / 100, table.flemishWoonbonusPre2015MinimumRate)
        } else if startYear == 2015 {
            cap = table.flemishWoonbonus2015BaseCap
            rate = table.flemishWoonbonusRate
        } else {
            cap = table.flemishIntegratedWoonbonusBaseCap
            rate = table.flemishWoonbonusRate
        }
        if loanAge < 10 {
            cap += table.flemishWoonbonusExtraFirst10y
            if woonbonusChildCount(inputs) >= 3 { cap += table.flemishWoonbonusExtraChildren }
        }
        return (cap, rate)
    }

    /// `ChequeHabitatParts`.
    struct ChequeHabitatParts {
        var base: Double
        var childSupplement: Double
        var factor: Double
    }

    /// `chequeHabitatParts(inputs, table, taxpayer)`; `nil` when no cheque is due.
    static func chequeHabitatParts(
        _ inputs: OwnHomeInputs, _ table: BelgianTaxTable, _ taxpayer: OwnHomeTaxpayer
    ) -> ChequeHabitatParts? {
        let income = TaxMath.max(taxpayer.taxableIncome, 0)
        let thresholds = table.walloonChequeHabitatIncomeThresholds
        if income > thresholds.upper { return nil }
        let base =
            income <= thresholds.lower
            ? table.walloonChequeHabitatBase
            : table.walloonChequeHabitatBase - (income - thresholds.lower) * table.walloonChequeHabitatPhaseOutRate
        let childSupplement = childCount(inputs) * table.walloonChequeHabitatChildSupplement
        let loanAge = TaxMath.max(0, taxpayer.incomeYear - (inputs.home.mortgageStartYear ?? 0))
        let first = inputs.home.firstQualifyingYear
        if let first, taxpayer.incomeYear < first { return nil }
        let period = first.map { taxpayer.incomeYear - $0 } ?? loanAge
        if period >= 20 { return nil }
        return ChequeHabitatParts(base: TaxMath.max(base, 0), childSupplement: childSupplement, factor: period >= 10 ? 0.5 : 1)
    }

    /// `computeOwnHomeCredit(inputs, table, regime, taxpayer)`.
    static func ownHomeCredit(
        _ inputs: OwnHomeInputs, _ table: BelgianTaxTable, _ regime: MortgageCreditRegime, _ taxpayer: OwnHomeTaxpayer
    ) -> Double {
        let payments = mortgagePayments(inputs.home)
        switch regime {
        case .flemishWoonbonus:
            let basket = woonbonusBasket(inputs, table, taxpayer)
            return TaxMath.min(payments, basket.cap) * basket.rate
        case .walloonChequeHabitat:
            guard let parts = chequeHabitatParts(inputs, table, taxpayer) else { return 0 }
            return TaxMath.min((parts.base + parts.childSupplement) * parts.factor, payments)
        case .none:
            return 0
        }
    }

    // MARK: Investment income

    /// `computeInvestmentSideCalc(dividends, savingsInterest, table)`.
    static func investmentSide(
        dividendIncome: Double?, savingsInterest: Double?, _ table: BelgianTaxTable
    ) -> (dividendWhtReclaim: Double, savingsInterestTax: Double) {
        let reclaim = TaxMath.min(TaxMath.amount(dividendIncome), table.dividendExemption) * table.dividendWHTRate
        let tax =
            TaxMath.max(TaxMath.amount(savingsInterest) - table.savingsInterestExemption, 0)
            * table.savingsInterestExcessRate
        return (reclaim, tax)
    }

    // MARK: Applied credits

    /// `AppliedTaxCreditParts`.
    struct AppliedCredits {
        var pension = 0.0
        var serviceVouchers = 0.0
        var otherReductions = 0.0
        var ownHome = 0.0

        /// `addAppliedTaxCreditParts`' step.
        static func + (a: AppliedCredits, b: AppliedCredits) -> AppliedCredits {
            AppliedCredits(
                pension: a.pension + b.pension, serviceVouchers: a.serviceVouchers + b.serviceVouchers,
                otherReductions: a.otherReductions + b.otherReductions, ownHome: a.ownHome + b.ownHome)
        }
    }

    /// `splitAppliedTaxCredits(applied, credits)`: which credits the applied amount covers, in
    /// the order pension, service vouchers, other reductions, own home.
    static func splitAppliedCredits(
        _ applied: Double, pension: Double, reductionsTotal: Double, serviceVouchers: Double, ownHome: Double
    ) -> AppliedCredits {
        var left = TaxMath.max(applied, 0)
        func take(_ amount: Double) -> Double {
            let part = TaxMath.min(TaxMath.max(amount, 0), left)
            left -= part
            return part
        }
        var parts = AppliedCredits()
        parts.pension = take(pension)
        parts.serviceVouchers = take(serviceVouchers)
        parts.otherReductions = take(reductionsTotal - serviceVouchers)
        parts.ownHome = take(ownHome)
        return parts
    }
}
