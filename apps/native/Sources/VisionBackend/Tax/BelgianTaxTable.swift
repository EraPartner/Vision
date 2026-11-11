import Foundation

/// A Belgian region (`BelgianRegion`), kept as the text a stored household states.
struct BelgianRegion: RawRepresentable, Hashable, Sendable {
    let rawValue: String

    static let flanders = BelgianRegion(rawValue: "flanders")
    static let wallonia = BelgianRegion(rawValue: "wallonia")
    static let brussels = BelgianRegion(rawValue: "brussels")
}

/// One value per region (`Record<BelgianRegion, T>`).
struct ByRegion<Value: Sendable>: Sendable {
    var flanders: Value
    var wallonia: Value
    var brussels: Value

    /// The region's value; `nil` for a region the tables do not know.
    subscript(region: BelgianRegion) -> Value? {
        switch region {
        case .flanders: return flanders
        case .wallonia: return wallonia
        case .brussels: return brussels
        default: return nil
        }
    }
}

/// The indexed amounts of one income year (`BelgianTaxYearTable` of
/// `packages/shared-utils/src/belgianTax/constants.ts`, which documents and sources every
/// field). The values live in `BelgianTaxTables.generated.swift`.
struct BelgianTaxTable: Sendable {
    /// A band with a rate (`PitBracket`, `ExemptionBracket`).
    struct Bracket: Sendable {
        var from: Double
        var to: Double
        var rate: Double
    }

    /// One tier of the special social security contribution scale (`CSSSTier`).
    struct ContributionTier: Sendable {
        var from: Double
        var to: Double
        var flat: Double?
        var rate: Double?
        var subtractBase: Double?
        var cap: Double?
    }

    struct Limits: Sendable {
        var lower: Double
        var upper: Double
    }

    struct StatutoryPensionLimits: Sendable {
        var lower: Double
        var upper: Double
        var difference: Double
    }

    struct ZeroLimits: Sendable {
        var from: Double
        var to: Double
    }

    /// `PensionReductionParams`.
    struct PensionReduction: Sendable {
        var base: Double
        var additional: Double
        var additionalLimits: Limits
        var statutoryPensionLimits: StatutoryPensionLimits
        var baseLimits: Limits
        var baseZeroLimits: ZeroLimits?
    }

    /// `SelfEmployedContributionParams`.
    struct SelfEmployedContributions: Sendable {
        var rate1: Double
        var rate2: Double
        var threshold1: Double
        var threshold2: Double
        var minimumIncome: Double
    }

    /// `RegionPropertyTaxParams`.
    struct PropertyTax: Sendable {
        var baseRate: Double
        var centimes: Double
    }

    /// `ServiceVoucherRegionalParams`.
    struct ServiceVouchers: Sendable {
        var rate: Double
        var spendCap: Double
        var voucherPrice: Double
    }

    struct RateAndCap: Sendable {
        var rate: Double
        var cap: Double
    }

    /// The stock exchange tax per asset kind (`tob`).
    struct ExchangeTax: Sendable {
        var bonds: RateAndCap
        var sharesAndOther: RateAndCap
        var accumulatingFunds: RateAndCap
        var distributingFunds: RateAndCap
    }

    private static let noLimits = Limits(lower: 0, upper: 0)
    private static let noRate = RateAndCap(rate: 0, cap: 0)

    var year = 0.0
    var brackets: [Bracket] = []
    var exemptionBrackets: [Bracket] = []
    var flemishWoonbonusBaseCap = 0.0
    var flemishWoonbonus2015BaseCap = 0.0
    var flemishIntegratedWoonbonusBaseCap = 0.0
    var flemishWoonbonusRate = 0.0
    var flemishWoonbonusPre2015MinimumRate = 0.0
    var flemishWoonbonusExtraFirst10y = 0.0
    var flemishWoonbonusExtraChildren = 0.0
    var walloonChequeHabitatBase = 0.0
    var walloonChequeHabitatChildSupplement = 0.0
    var walloonChequeHabitatIncomeThresholds = noLimits
    var walloonChequeHabitatPhaseOutRate = 0.0
    var pensionReduction = PensionReduction(
        base: 0, additional: 0, additionalLimits: noLimits,
        statutoryPensionLimits: StatutoryPensionLimits(lower: 0, upper: 0, difference: 0), baseLimits: noLimits)
    var basicPersonalExemption = 0.0
    var dependentChildExemptionIncreases: [Double] = []
    var extraChildExemptionFromFifth = 0.0
    var childUnder3Supplement = 0.0
    var otherDependentExemption = 0.0
    var disabledSupplement = 0.0
    var isolatedParentSupplement = 0.0
    var employeeSSRate = 0.0
    var civilServantSSRate = 0.0
    var selfEmployedContributions = SelfEmployedContributions(
        rate1: 0, rate2: 0, threshold1: 0, threshold2: 0, minimumIncome: 0)
    var csssTable: [ContributionTier] = []
    var csssTableJoint: [ContributionTier] = []
    var employeeProfessionalExpenseRate = 0.0
    var employeeProfessionalExpenseCap = 0.0
    var directorProfessionalExpenseRate = 0.0
    var directorProfessionalExpenseCap = 0.0
    var selfEmployedFeesExpenseBrackets: [Bracket] = []
    var selfEmployedFeesExpenseCap = 0.0
    var helpingSpouseProfessionalExpenseRate = 0.0
    var pensionSavingsCapStandard = 0.0
    var pensionSavingsRateStandard = 0.0
    var pensionSavingsCapAlternative = 0.0
    var pensionSavingsRateAlternative = 0.0
    var lifeInsuranceCap = 0.0
    var lifeInsuranceRate = 0.0
    var groupInsuranceRate = 0.0
    var charitableDonationMin = 0.0
    var charitableDonationRate = 0.0
    var charitableDonationAbsoluteCap = 0.0
    var childcareDailyCap = 0.0
    var childcareRate = 0.0
    var domesticHelpRate = 0.0
    var domesticHelpCap = 0.0
    var alimonyDeductibleFraction = 0.0
    var dividendExemption = 0.0
    var dividendWHTRate = 0.0
    var savingsInterestExemption = 0.0
    var savingsInterestExcessRate = 0.0
    var securitiesAccountTaxRate = 0.0
    var securitiesAccountTaxThreshold = 0.0
    var capitalGainsTaxRate = 0.0
    var capitalGainsTaxExemptionSingle = 0.0
    var capitalGainsTaxExemptionMarried = 0.0
    var reyndersTaxRate = 0.0
    var reyndersBondThreshold = 0.0
    var maritalQuotientRate = 0.0
    var maritalQuotientCap = 0.0
    var maritalQuotientCapBothSenior: Double?
    var treatyExemptSeparateThreshold = 0.0
    var refundableChildCreditCapPerChild = 0.0
    var tob = ExchangeTax(bonds: noRate, sharesAndOther: noRate, accumulatingFunds: noRate, distributingFunds: noRate)
    var regionalAutonomyFactor = ByRegion<Double>(flanders: 0, wallonia: 0, brussels: 0)
    var cadastralIndexationCoefficient = 0.0
    var regionPropertyTax = ByRegion(
        flanders: PropertyTax(baseRate: 0, centimes: 0), wallonia: PropertyTax(baseRate: 0, centimes: 0),
        brussels: PropertyTax(baseRate: 0, centimes: 0))
    var serviceVoucherRegional = ByRegion(
        flanders: ServiceVouchers(rate: 0, spendCap: 0, voucherPrice: 0),
        wallonia: ServiceVouchers(rate: 0, spendCap: 0, voucherPrice: 0),
        brussels: ServiceVouchers(rate: 0, spendCap: 0, voucherPrice: 0))
    var defaultCommunalSurcharge = ByRegion<Double>(flanders: 0, wallonia: 0, brussels: 0)

    /// `getTaxTable(year)`: the year's table, the earliest one for an earlier year and the
    /// latest one for a later year.
    static func table(for year: Double) -> BelgianTaxTable {
        if let exact = byYear.first(where: { $0.year == year }) { return exact }
        // The generated list is in year order and never empty.
        return year < earliestYear ? byYear[0] : byYear[byYear.count - 1]
    }

    /// `isApproximatedTaxYear(year)`.
    static func isApproximated(year: Double) -> Bool { !byYear.contains { $0.year == year } }
}
