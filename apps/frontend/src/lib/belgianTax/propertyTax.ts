import type { BelgianRegion, BelgianTaxProfile } from './types';
import type { BelgianTaxYearTable } from './constants';

/**
 * Estimate annual Belgian property tax (précompte immobilier / onroerende voorheffing).
 *
 * Formula:
 *   indexedCI   = nominalCI × indexationCoefficient
 *   regionalTax = indexedCI × regionalBaseRate
 *   totalTax    = regionalTax × (1 + centimes/100)
 *
 * Where:
 *  - Flanders regional base rate = 3.97 %
 *  - Wallonia / Brussels regional base rate = 1.25 %
 *  - centimes additionnels = communal + provincial surcharges (median estimate per region)
 *
 * The result is an order-of-magnitude estimate. Actual précompte depends on the specific
 * commune (centimes communaux can range from ~600 to >3000) and any rebates (e.g. modest
 * dwelling, dependent children — Flanders only). Used for informational display.
 */
function isValidCentimes(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function estimateForResidence(
    cadastralIncome: number,
    region: BelgianRegion,
    table: BelgianTaxYearTable,
    centimesOverride?: number,
): number {
    if (cadastralIncome <= 0) return 0;
    const params = table.regionPropertyTax[region];
    const indexed = cadastralIncome * table.cadastralIndexationCoefficient;
    const regionalTax = indexed * params.baseRate;
    const centimes = isValidCentimes(centimesOverride) ? centimesOverride : params.centimes;
    return regionalTax * (1 + centimes / 100);
}

export function computePropertyTaxEstimate(profile: BelgianTaxProfile, table: BelgianTaxYearTable): number {
    const main = estimateForResidence(
        profile.cadastralIncome || 0,
        profile.region,
        table,
        profile.cadastralCentimesOverride,
    );
    const additional = (profile.additionalResidences || []).reduce((sum, r) => {
        return sum + estimateForResidence(
            r.cadastralIncome || 0,
            r.region || profile.region,
            table,
            r.centimesOverride,
        );
    }, 0);
    return main + additional;
}
