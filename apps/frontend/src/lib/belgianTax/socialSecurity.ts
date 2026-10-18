import type { BelgianTaxProfile } from './types';
import type { BelgianTaxYearTable, CSSSTier } from './constants';
import type { ActivityKind } from './householdTypes';

/**
 * Employee social security contribution (RSZ / ONSS).
 *
 * Applied to gross **salary** only (not other taxable income such as rental, dividends).
 * Statutory civil servants pay 11.05%: the 3.55% health-care contribution plus the 7.5%
 * survivors'-pension deduction (sources in constants.ts).
 */
export function computeEmployeeSocialSecurity(profile: BelgianTaxProfile, table: BelgianTaxYearTable): number {
    if (profile.employmentType === 'employee') {
        return profile.grossAnnualIncome * table.employeeSSRate;
    }
    if (profile.employmentType === 'civil_servant') {
        return profile.grossAnnualIncome * table.civilServantSSRate;
    }
    return 0;
}

/**
 * Special social security contribution ("CSSS" / "bijzondere bijdrage voor de sociale zekerheid").
 *
 * Law of 30 March 1994 art. 108 §1 (as amended by the laws of 28 March 2022 and
 * 20 November 2022): a step function on the **household income** of art. 107, 2°. Two annual
 * scales exist:
 *  - `csssTable` for taxpayers assessed alone, cap €731.28;
 *  - `csssTableJoint` for a joint assessment (`gemeenschappelijke aanslag`), applied to the sum
 *    of both spouses' income, same household cap €731.28.
 *
 * The joint table is used when `profile.filingStatus === 'married_joint'`; the caller passes
 * the household base. Returns 0 for taxpayers outside art. 106 (self-employed, pensioners),
 * who owe no CSSS.
 */
export function computeSpecialSocialSecurityContribution(
    profile: BelgianTaxProfile,
    netTaxableIncome: number,
    table: BelgianTaxYearTable,
): number {
    const subject = profile.employmentType === 'employee' || profile.employmentType === 'civil_servant';
    if (!subject) return 0;
    if (netTaxableIncome <= 0) return 0;

    const tiers =
        profile.filingStatus === 'married_joint' ? table.csssTableJoint : table.csssTable;
    return evaluateCsssScale(netTaxableIncome, tiers);
}

/**
 * Evaluate one CSSS scale (law of 30 March 1994 art. 108 §1) on a household income.
 * Returns 0 for a non-positive base.
 */
export function evaluateCsssScale(
    netTaxableIncome: number,
    tiers: ReadonlyArray<CSSSTier>,
): number {
    if (netTaxableIncome <= 0) return 0;
    for (const tier of tiers) {
        // Tier bounds are [from, to] with the upper bound inclusive; consecutive tiers
        // share their boundary, and the first matching tier wins. Each tier is continuous
        // with the next at the shared boundary, so the choice does not change the result.
        if (netTaxableIncome < tier.from) continue;
        if (netTaxableIncome > tier.to) continue;

        const flat = tier.flat ?? 0;
        if (tier.rate && tier.subtractBase !== undefined) {
            const variable = Math.max(0, netTaxableIncome - tier.subtractBase) * tier.rate;
            const total = flat + variable;
            return tier.cap !== undefined ? Math.min(total, tier.cap) : total;
        }
        return flat;
    }
    return 0;
}

/**
 * Personal social security on one activity's gross income: 13.07% for employees, the 11.05%
 * civil-servant rate for statutory civil servants, 0 for every other activity kind (the
 * self-employed pay their own contributions, which the household engine stores but does not
 * deduct).
 */
export function computeActivitySocialSecurity(
    kind: ActivityKind,
    grossIncome: number,
    table: BelgianTaxYearTable,
): number {
    const gross = Math.max(grossIncome || 0, 0);
    if (kind === 'employee') return gross * table.employeeSSRate;
    if (kind === 'civil_servant') return gross * table.civilServantSSRate;
    return 0;
}

/**
 * Estimated yearly self-employed social contributions (RSVZ / INASTI) for a main-occupation
 * self-employed person before pension age: Royal Decree no. 38 of 27 July 1967 art. 12 §1.
 *  - 20.50% on the income up to `threshold1`, computed on at least `minimumIncome` ("worden de
 *    beroepsinkomsten van de onderworpene geacht … te bereiken");
 *  - 14.16% on the part between `threshold1` and `threshold2`;
 *  - nothing above `threshold2`.
 * Thresholds are indexed yearly under art. 14 (`selfEmployedContributions` in the year table).
 * Secondary occupation, starters, pensioners and the management fees of the social insurance
 * funds are not covered. This is an estimate helper: the household engine deducts the amount the
 * user enters as `socialContributionsPaid`, not this value.
 */
export function estimateSelfEmployedContributions(
    netProfessionalIncome: number,
    table: Pick<BelgianTaxYearTable, 'selfEmployedContributions'>,
): number {
    const p = table.selfEmployedContributions;
    const income = Number.isFinite(netProfessionalIncome) ? Math.max(netProfessionalIncome, 0) : 0;
    const band1 = Math.min(Math.max(income, p.minimumIncome), p.threshold1);
    const band2 = Math.max(Math.min(income, p.threshold2) - p.threshold1, 0);
    return band1 * p.rate1 + band2 * p.rate2;
}
