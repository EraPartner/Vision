/**
 * Regional own-home credit of a household (Flemish woonbonus, Walloon chèque habitat).
 *
 * One borrower (default): the whole credit goes to `home.mortgageCreditPartnerId` (default A),
 * computed on that partner's income, as in `computeBelgianPIT`.
 *
 * Two borrowers (`home.mortgageSharePartnerB` strictly between 0 and 100, both partners
 * assessed): each borrower has a basket of their own.
 *  - Flemish woonbonus: the caps apply "per belastingplichtige" (arts 145/37 §2, 145/38/2 §2).
 *    Under a joint assessment in which both spouses paid, "kunnen de echtgenoten deze uitgaven
 *    vrij verdelen binnen de begrenzingen" (arts 145/37 §3, 145/38/2 §3): the payments go first
 *    where they reduce tax, up to each borrower's cap and tax room (`taxRoom`, the tax left for
 *    the credit), the higher rate first; at equal rates each borrower keeps their own payments
 *    and only the part their own basket cannot use moves to the other. Payments that still fit
 *    under a cap but find no tax room are claimed last (that credit is lost). Outside a joint
 *    assessment each borrower claims their own share of the payments.
 *  - Walloon chèque habitat: a "réduction d'impôt forfaitaire et individuelle" per taxpayer, on
 *    that taxpayer's own income, capped "par contribuable" at their payments, which are split
 *    "au prorata de la part de propriété" (art. 145/46ter; FPS circular 2026/C/18). Under a
 *    joint assessment "les conjoints peuvent répartir librement" the €125 per child: it goes
 *    first to the borrower with the most room under their payments cap. Outside a joint
 *    assessment the children count only for the borrower who claims them.
 */

import type { BelgianTaxYearTable } from "./constants";
import {
    chequeHabitatParts,
    computeMarginalRate,
    computeOwnHomeCredit,
    mortgagePayments,
    resolveMortgageRegime,
    woonbonusBasket,
    type ChequeHabitatParts,
    type OwnHomeCreditInputs,
    type OwnHomeCreditTaxpayer,
} from "./personPit";
import type { MortgageCreditRegime } from "./types";
import type {
    AssessmentMode,
    BelgianTaxHouseholdV2,
    HouseholdTaxIssue,
    PartnerId,
} from "./householdTypes";

/** Figures of one assessed partner that the own-home credit reads. */
export interface OwnHomePartner {
    id: PartnerId;
    /** Taxable income before the marital quotient (income limits, pre-2015 marginal rate). */
    taxableIncomeBeforeQuotient: number;
}

export interface OwnHomeAllocation {
    regime: MortgageCreditRegime;
    /** Partners who carry an own-home basket (empty when no partner is assessed). */
    borrowers: PartnerId[];
    /** Own-home credit per assessed partner (0 for a partner who is not a borrower). */
    credits: Partial<Record<PartnerId, number>>;
    issues: HouseholdTaxIssue[];
}

/** Partner B's share of the payments as a fraction, or undefined for the one-borrower path. */
export function twoBorrowerShareB(
    home: BelgianTaxHouseholdV2["home"],
    partners: readonly OwnHomePartner[],
): number | undefined {
    const share = home.mortgageSharePartnerB;
    if (share === undefined || !(share > 0 && share < 100)) return undefined;
    if (!partners.some((p) => p.id === "A") || !partners.some((p) => p.id === "B")) {
        return undefined;
    }
    return share / 100;
}

/**
 * The borrower of the one-borrower path: `mortgageCreditPartnerId` (default A), or B when
 * `mortgageSharePartnerB` is 100 and A when it is 0; the first assessed partner when that
 * partner is not assessed.
 */
function singleBorrower(
    home: BelgianTaxHouseholdV2["home"],
    partners: readonly OwnHomePartner[],
): PartnerId | undefined {
    const named: PartnerId =
        home.mortgageSharePartnerB === 100
            ? "B"
            : home.mortgageSharePartnerB === 0
              ? "A"
              : (home.mortgageCreditPartnerId ?? "A");
    return partners.some((p) => p.id === named) ? named : partners[0]?.id;
}

/**
 * Joint woonbonus split of `payments` between two baskets (index 0 = A, 1 = B). Phase 1 fills
 * each basket up to the payments whose credit the borrower's tax can absorb (`useful`), phase 2
 * up to the cap. Within a phase the higher rate goes first; at equal rates each borrower first
 * takes their own payments (`own`), then the other's.
 */
export function splitJointWoonbonus(
    payments: number,
    own: readonly [number, number],
    caps: readonly [number, number],
    rates: readonly [number, number],
    useful: readonly [number, number],
): [number, number] {
    const claimed: [number, number] = [0, 0];
    const phases = [
        [Math.min(useful[0], caps[0]), Math.min(useful[1], caps[1])],
        caps,
    ] as const;
    if (rates[0] !== rates[1]) {
        const order: readonly (0 | 1)[] = rates[0] > rates[1] ? [0, 1] : [1, 0];
        let pool = payments;
        for (const limits of phases) {
            for (const i of order) {
                const add = Math.max(Math.min(pool, limits[i] - claimed[i]), 0);
                claimed[i] += add;
                pool -= add;
            }
        }
        return claimed;
    }
    const left: [number, number] = [own[0], own[1]];
    const steps: readonly (readonly [0 | 1, 0 | 1])[] = [
        [0, 0],
        [1, 1],
        [0, 1],
        [1, 0],
    ];
    for (const limits of phases) {
        for (const [i, from] of steps) {
            const add = Math.max(Math.min(left[from], limits[i] - claimed[i]), 0);
            claimed[i] += add;
            left[from] -= add;
        }
    }
    return claimed;
}

/** Split the couple's €125-per-child amount between two chèque-habitat borrowers (joint). */
function splitChildSupplement(
    parts: readonly [ChequeHabitatParts | undefined, ChequeHabitatParts | undefined],
    own: readonly [number, number],
): [number, number] {
    const total = (parts[0] ?? parts[1])?.childSupplement ?? 0;
    const room = parts.map((pt, i) =>
        pt ? Math.max((own[i] as number) / pt.factor - pt.base, 0) : -1,
    ) as [number, number];
    const first = room[1] > room[0] ? 1 : 0;
    const second = 1 - first;
    const result: [number, number] = [0, 0];
    let left = total;
    if (parts[first]) {
        result[first] = parts[second] ? Math.min(left, room[first]) : left;
        left -= result[first];
    }
    if (parts[second]) result[second] = left;
    return result;
}

export function allocateOwnHomeCredit(args: {
    household: BelgianTaxHouseholdV2;
    partners: readonly OwnHomePartner[];
    mode: AssessmentMode;
    /** Partner who claims the dependent children outside a joint assessment. */
    childrenClaimantId: PartnerId | undefined;
    table: BelgianTaxYearTable;
    incomeYear: number;
    /**
     * Tax each partner has left for the own-home credit (after the tax-free sum and the other
     * reductions). Steers the joint woonbonus split; without it the tax is not limiting.
     */
    taxRoom?: Partial<Record<PartnerId, number>>;
}): OwnHomeAllocation {
    const { household, partners, mode, childrenClaimantId, table, incomeYear, taxRoom } = args;
    const home = household.home;
    const issues: HouseholdTaxIssue[] = [];
    if (home.mortgageRegion !== undefined && home.mortgageRegion !== household.region) {
        issues.push({ code: "mortgage_region_not_used", severity: "info" });
    }
    // Outside a joint assessment a child is the dependant of the partner who claims it (the
    // art. 132 supplements follow the same claimant), so this year's children count for the
    // own-home credit (Walloon art. 145/46ter §2; the Flemish +80 proxy when
    // `woonbonusChildrenAtLoanStart` is absent) only for that partner.
    const inputsFor = (id: PartnerId): OwnHomeCreditInputs => {
        const hasChildren = mode === "joint" || childrenClaimantId === id;
        return {
            ...home,
            region: household.region,
            dependentChildren: hasChildren ? household.dependents.children : 0,
            dependentChildrenDisabled: hasChildren
                ? (household.dependents.childrenDisabled ?? 0)
                : 0,
        };
    };
    const taxpayerOf = (p: OwnHomePartner): OwnHomeCreditTaxpayer => ({
        taxableIncome: p.taxableIncomeBeforeQuotient,
        marginalRatePercent: computeMarginalRate(p.taxableIncomeBeforeQuotient, table.brackets),
        incomeYear,
    });
    const regime = resolveMortgageRegime(inputsFor("A"));
    const shareB = twoBorrowerShareB(home, partners);
    const borrowers: PartnerId[] =
        shareB === undefined
            ? [singleBorrower(home, partners)].filter((id): id is PartnerId => id !== undefined)
            : ["A", "B"];

    // Without the borrower's children on 1 January after the loan year, the woonbonus +80 rests
    // on this year's children of the claimant (a proxy), so say so while the +760 period runs.
    if (
        regime === "flemish_woonbonus" &&
        home.woonbonusChildrenAtLoanStart === undefined &&
        incomeYear - (home.mortgageStartYear ?? 0) < 10
    ) {
        for (const id of borrowers) {
            issues.push({
                code: "woonbonus_children_at_loan_start_missing",
                severity: "info",
                partnerId: id,
            });
        }
    }

    const credits: Partial<Record<PartnerId, number>> = {};
    for (const p of partners) credits[p.id] = 0;
    const borrower = (id: PartnerId): OwnHomePartner | undefined =>
        partners.find((p) => p.id === id);

    if (shareB === undefined) {
        const id = borrowers[0];
        const p = id === undefined ? undefined : borrower(id);
        if (id !== undefined && p) {
            credits[id] = computeOwnHomeCredit(inputsFor(id), table, regime, taxpayerOf(p));
        }
        return { regime, borrowers, credits, issues };
    }
    const pa = borrower("A");
    const pb = borrower("B");
    if (regime === "none" || !pa || !pb) return { regime, borrowers, credits, issues };

    const payments = mortgagePayments(home);
    const own: [number, number] = [payments * (1 - shareB), payments * shareB];

    if (regime === "flemish_woonbonus") {
        const baskets = [
            woonbonusBasket(inputsFor("A"), table, taxpayerOf(pa)),
            woonbonusBasket(inputsFor("B"), table, taxpayerOf(pb)),
        ] as const;
        let claimed: [number, number] = [
            Math.min(own[0], baskets[0].cap),
            Math.min(own[1], baskets[1].cap),
        ];
        if (mode === "joint") {
            const usefulOf = (id: PartnerId, rate: number): number => {
                const room = taxRoom?.[id];
                return room === undefined ? Infinity : rate > 0 ? Math.max(room, 0) / rate : 0;
            };
            claimed = splitJointWoonbonus(
                payments,
                own,
                [baskets[0].cap, baskets[1].cap],
                [baskets[0].rate, baskets[1].rate],
                [usefulOf("A", baskets[0].rate), usefulOf("B", baskets[1].rate)],
            );
        }
        credits.A = claimed[0] * baskets[0].rate;
        credits.B = claimed[1] * baskets[1].rate;
        return { regime, borrowers, credits, issues };
    }

    // Walloon chèque habitat: each borrower's own income-based amount and payments cap.
    const parts = [
        chequeHabitatParts(inputsFor("A"), table, taxpayerOf(pa)),
        chequeHabitatParts(inputsFor("B"), table, taxpayerOf(pb)),
    ] as const;
    const children: [number, number] =
        mode === "joint"
            ? splitChildSupplement(parts, own)
            : [parts[0]?.childSupplement ?? 0, parts[1]?.childSupplement ?? 0];
    const creditOf = (i: 0 | 1): number => {
        const pt = parts[i];
        return pt ? Math.min((pt.base + children[i]) * pt.factor, own[i]) : 0;
    };
    credits.A = creditOf(0);
    credits.B = creditOf(1);
    return { regime, borrowers, credits, issues };
}
