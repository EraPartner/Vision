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
 * Step function on **net taxable income** (single-filer table; couple-table approximation).
 * Returns 0 for income types that are not subject to it (self-employed, retired without salary).
 */
export function computeSpecialSocialSecurityContribution(
    profile: BelgianTaxProfile,
    netTaxableIncome: number,
    table: BelgianTaxYearTable,
): number {
    const subject = profile.employmentType === 'employee' || profile.employmentType === 'civil_servant';
    if (!subject) return 0;
    if (netTaxableIncome <= 0) return 0;

    for (const tier of table.csssTable) {
        if (netTaxableIncome <= tier.from) continue;
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
