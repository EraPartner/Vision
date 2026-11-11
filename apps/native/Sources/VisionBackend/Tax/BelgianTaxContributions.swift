import Foundation

/// What the engine cannot compute, where the TypeScript engine throws a `TypeError`.
enum BelgianTaxError: Error, Equatable {
    /// A residence with cadastral income lies in a region the tables do not know.
    case unknownRegion(String)
    /// A stored value lacks a member the engine reads without checking.
    case malformed(String)
}

/// `socialSecurity.ts` and `propertyTax.ts`.
enum TaxContributions {
    /// `evaluateCsssScale(netTaxableIncome, tiers)`: the special social security contribution.
    static func specialContribution(_ netTaxableIncome: Double, _ tiers: [BelgianTaxTable.ContributionTier]) -> Double {
        if netTaxableIncome <= 0 { return 0 }
        for tier in tiers {
            if netTaxableIncome < tier.from || netTaxableIncome > tier.to { continue }
            let flat = tier.flat ?? 0
            if let rate = tier.rate, rate != 0, let subtractBase = tier.subtractBase {
                let total = flat + TaxMath.max(0, netTaxableIncome - subtractBase) * rate
                return tier.cap.map { TaxMath.min(total, $0) } ?? total
            }
            return flat
        }
        return 0
    }

    /// `computeActivitySocialSecurity(kind, grossIncome, table)`.
    static func activitySocialSecurity(_ kind: HouseholdActivityKind, _ grossIncome: Double, _ table: BelgianTaxTable) -> Double {
        let gross = TaxMath.amount(grossIncome)
        if kind == .employee { return gross * table.employeeSSRate }
        if kind == .civilServant { return gross * table.civilServantSSRate }
        return 0
    }

    /// `estimateSelfEmployedContributions(netProfessionalIncome, table)`.
    static func selfEmployedContributions(_ netProfessionalIncome: Double, _ table: BelgianTaxTable) -> Double {
        let parameters = table.selfEmployedContributions
        let income = netProfessionalIncome.isFinite ? TaxMath.max(netProfessionalIncome, 0) : 0
        let band1 = TaxMath.min(TaxMath.max(income, parameters.minimumIncome), parameters.threshold1)
        let band2 = TaxMath.max(TaxMath.min(income, parameters.threshold2) - parameters.threshold1, 0)
        return band1 * parameters.rate1 + band2 * parameters.rate2
    }

    private static func residenceTax(
        _ cadastralIncome: Double, _ region: BelgianRegion, _ table: BelgianTaxTable, centimesOverride: Double?
    ) throws -> Double {
        if cadastralIncome <= 0 { return 0 }
        guard let parameters = table.regionPropertyTax[region] else {
            throw BelgianTaxError.unknownRegion(region.rawValue)
        }
        let regionalTax = cadastralIncome * table.cadastralIndexationCoefficient * parameters.baseRate
        var centimes = parameters.centimes
        if let override = centimesOverride, override.isFinite, override >= 0 { centimes = override }
        return regionalTax * (1 + centimes / 100)
    }

    /// `computePropertyTaxEstimate(profile, table)`.
    static func propertyTax(_ home: TaxHousehold.Home, _ region: BelgianRegion, _ table: BelgianTaxTable) throws -> Double {
        let main = try residenceTax(
            TaxMath.orZero(home.cadastralIncome), region, table, centimesOverride: home.cadastralCentimesOverride)
        var additional = 0.0
        for residence in home.additionalResidences {
            additional =
                additional
                + (try residenceTax(
                    TaxMath.orZero(residence.cadastralIncome), residence.region ?? region, table,
                    centimesOverride: residence.centimesOverride))
        }
        return main + additional
    }
}
