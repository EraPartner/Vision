import type { BelgianTaxProfile } from './types';
import type { BelgianTaxYearTable } from './constants';

/**
 * Employee social security contribution (RSZ / ONSS).
 *
 * Applied to gross **salary** only (not other taxable income such as rental, dividends).
 * Civil servants pay a reduced rate (no unemployment insurance portion).
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
