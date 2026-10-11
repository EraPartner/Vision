/**
 * Belgian PIT for a household of one or two partners (engine version 2).
 *
 * Pipeline (each step cites a row of docs/reference/belgian-tax-rule-matrix.md):
 *  1. Year table; assessment mode from the relationship events (art. 126, `assessment.ts`).
 *  2. Per activity: employee social security (13.07% / civil servant rate); self-employed
 *     social contributions entered by the user (art. 52, 7°) for profits, fees and helping
 *     spouses. Both come off the gross before the forfait (art. 51 al. 1).
 *  3. Per partner and art. 51 forfait category: one forfait or actual claim per category, the
 *     cap applying to the category as a whole (art. 51 al. 3). Union dues only inside an actual
 *     remuneration claim. Category net income is clamped at 0 (loss offset not modelled).
 *  4. Alimony deduction (art. 104, 1°-2°) on the payer's income; under joint assessment the
 *     balance goes to the other spouse (art. 105, 3°).
 *  5. Marital quotient on net professional income (arts 87-88, joint only).
 *  6. Tax-free sum per partner with dependent supplements and the joint remainder transfer
 *     (arts 131-134, `exemptions.ts`).
 *  7. Progressive tax per partner (art. 130: "op het belastbare inkomen van elke
 *     belastingplichtige").
 *  8. Reductions per partner, capped at that partner's tax; regional factor; communal surcharge.
 *  9. CSSS (law of 30 March 1994 arts 106-108): joint scale on the household income under a
 *     joint assessment, the single scale per subject partner otherwise.
 * 10. Property tax (household), investment side calculation (per partner), totals.
 */

import { getTaxTable, type BelgianTaxYearTable } from "./constants";
import { deriveAssessment } from "./assessment";
import {
    allocateExemptions,
    resolveDependentsClaimant,
    type ExemptionPartnerInput,
} from "./exemptions";
import {
    computeMaritalQuotient,
    resolveMaritalQuotientCap,
    type QuotientTransfer,
} from "./maritalQuotient";
import {
    addBracketTax,
    buildCalculationBreakdown,
    clampAtZero,
    computeExemptionBenefit,
    computeInvestmentSideCalc,
    computeMarginalRate,
    computeOwnHomeCredit,
    computeProfessionalExpenseClaim,
    computeProgressiveTax,
    computeTaxReductions,
    type TaxReductionBreakdown,
    isChildcareDeducted,
    resolveMortgageRegime,
    type ForfaitCategory,
} from "./personPit";
import { computePropertyTaxEstimate } from "./propertyTax";
import {
    computeActivitySocialSecurity,
    evaluateCsssScale,
} from "./socialSecurity";
import type { BelgianTaxCalculation, BracketTax } from "./types";
import {
    FORFAIT_CATEGORIES,
    type ActivityKind,
    type ActivityTaxResult,
    type BelgianTaxHouseholdV2,
    type CategoryTaxResult,
    type ExemptionAllocation,
    type HouseholdPartner,
    type HouseholdTaxIssue,
    type HouseholdTaxResult,
    type MaritalQuotientResult,
    type PartnerId,
    type PartnerTaxResult,
} from "./householdTypes";

/** Art. 51 forfait category of an activity kind. */
export function forfaitCategoryOf(kind: ActivityKind): ForfaitCategory {
    switch (kind) {
        case "employee":
        case "civil_servant":
            return "remuneration";
        case "director":
            return "director";
        case "self_employed_profits":
            return "profits";
        case "self_employed_fees":
            return "fees";
        case "helping_spouse":
            return "helping_spouse";
        default:
            return "none";
    }
}

/** Activity kinds whose personal social contributions (art. 52, 7°) the user enters. */
const SELF_EMPLOYED_CONTRIBUTION_KINDS: ReadonlySet<ActivityKind> = new Set([
    "self_employed_profits",
    "self_employed_fees",
    "helping_spouse",
]);

/** Activity kinds of persons subject to the CSSS (law of 30 March 1994 art. 106). */
const CSSS_SUBJECT_KINDS: ReadonlySet<ActivityKind> = new Set(["employee", "civil_servant"]);

/** Professional activity kinds outside art. 106 that may enter a subject person's base. */
const CSSS_OTHER_PROFESSIONAL_KINDS: ReadonlySet<ActivityKind> = new Set([
    "director",
    "self_employed_profits",
    "self_employed_fees",
    "helping_spouse",
    "other_professional",
]);

interface PartnerIncome {
    partner: HouseholdPartner;
    activities: ActivityTaxResult[];
    categories: CategoryTaxResult[];
    grossIncome: number;
    employeeSocialSecurity: number;
    professionalExpenses: number;
    unionDuesApplied: number;
    netProfessionalIncome: number;
    /** Part of the net professional income given as an already-net amount. */
    netAmountIncome: number;
    /** Net professional income without pensions (art. 107, 2° of the CSSS law). */
    csssBase: number;
    csssSubject: boolean;
    otherTaxableIncome: number;
    alimonyDeduction: number;
    taxableIncomeBeforeQuotient: number;
}

function computePartnerIncome(
    partner: HouseholdPartner,
    table: BelgianTaxYearTable,
    issues: HouseholdTaxIssue[],
): PartnerIncome {
    const activities: ActivityTaxResult[] = [];
    const grossAfter = new Map<string, number>();
    let netAmountIncome = 0;
    let grossIncome = 0;
    let employeeSocialSecurity = 0;

    for (const activity of partner.activities) {
        const category = forfaitCategoryOf(activity.kind);
        if (activity.kind === "net_professional_amount") {
            const net = Math.max(activity.netProfessionalIncome ?? 0, 0);
            netAmountIncome += net;
            activities.push({
                activityId: activity.id,
                kind: activity.kind,
                forfaitCategory: category,
                grossIncome: 0,
                employeeSocialSecurity: 0,
                socialContributionsPaid: 0,
                professionalExpenses: 0,
                netProfessionalIncome: net,
            });
            continue;
        }
        const gross = Math.max(activity.grossIncome || 0, 0);
        const ss = computeActivitySocialSecurity(activity.kind, gross, table);
        const contributions = SELF_EMPLOYED_CONTRIBUTION_KINDS.has(activity.kind)
            ? Math.max(activity.socialContributionsPaid ?? 0, 0)
            : 0;
        if (
            activity.kind === "director" &&
            (activity.socialContributionsPaid ?? 0) > 0
        ) {
            issues.push({
                code: "director_contributions_not_deducted",
                severity: "needs_source",
                partnerId: partner.id,
                activityId: activity.id,
            });
        }
        grossIncome += gross;
        employeeSocialSecurity += ss;
        // Art. 51 al. 1: the forfait base is the gross "vooraf verminderd met" the art. 52, 7°
        // contributions; the same contributions are deductible professional expenses.
        grossAfter.set(activity.id, Math.max(gross - Math.max(ss, 0) - contributions, 0));
        activities.push({
            activityId: activity.id,
            kind: activity.kind,
            forfaitCategory: category,
            grossIncome: gross,
            employeeSocialSecurity: ss,
            socialContributionsPaid: contributions,
            professionalExpenses: 0,
            netProfessionalIncome: 0,
        });
    }

    const categories: CategoryTaxResult[] = [];
    let professionalExpenses = 0;
    let unionDuesApplied = 0;
    let categoryNetTotal = 0;
    let csssBase = netAmountIncome;
    for (const category of FORFAIT_CATEGORIES) {
        const members = activities.filter(
            (a) => a.forfaitCategory === category && a.kind !== "net_professional_amount",
        );
        if (members.length === 0) continue;
        let base = 0;
        for (const m of members) base += grossAfter.get(m.activityId) ?? 0;
        const choice = partner.professionalExpenses[category];
        const method = choice?.method ?? "lump_sum";
        const unionDues =
            category === "remuneration" && method === "actual"
                ? Math.max(partner.unionDues || 0, 0)
                : 0;
        const expenses = computeProfessionalExpenseClaim(
            {
                category,
                grossAfterContributions: base,
                method,
                actualAmount: choice?.actualAmount ?? 0,
                unionDues,
            },
            table,
        );
        const rawNet = base - expenses;
        if (rawNet < 0) {
            issues.push({
                code: "loss_offset_not_modelled",
                severity: "warning",
                partnerId: partner.id,
            });
        }
        const netIncome = clampAtZero(rawNet);
        categories.push({
            category,
            method,
            grossAfterContributions: base,
            professionalExpenses: expenses,
            unionDuesApplied: unionDues,
            netIncome,
        });
        professionalExpenses += expenses;
        unionDuesApplied += unionDues;
        categoryNetTotal += netIncome;

        let pensionShare = 0;
        for (const m of members) {
            const share =
                base > 0 ? (grossAfter.get(m.activityId) ?? 0) / base : 1 / members.length;
            m.professionalExpenses = expenses * share;
            m.netProfessionalIncome = netIncome * share;
            if (m.kind === "pension") pensionShare += share;
        }
        csssBase += pensionShare > 0 ? netIncome * (1 - pensionShare) : netIncome;
    }

    if (
        categories.some((c) => c.category === "remuneration") &&
        categories.some((c) => c.category === "profits")
    ) {
        issues.push({
            code: "forfait_category_aggregation_unverified",
            severity: "needs_source",
            partnerId: partner.id,
        });
    }
    if (
        (partner.unionDues || 0) > 0 &&
        !categories.some((c) => c.category === "remuneration" && c.method === "actual") &&
        categories.some((c) => c.method === "actual")
    ) {
        issues.push({
            code: "union_dues_outside_remuneration_claim",
            severity: "info",
            partnerId: partner.id,
        });
    }

    const kinds = new Set(activities.map((a) => a.kind));
    const csssSubject = [...kinds].some((k) => CSSS_SUBJECT_KINDS.has(k));
    if (csssSubject && [...kinds].some((k) => CSSS_OTHER_PROFESSIONAL_KINDS.has(k))) {
        issues.push({
            code: "csss_mixed_activity_base_unverified",
            severity: "needs_source",
            partnerId: partner.id,
        });
    }

    const netProfessionalIncome =
        netAmountIncome > 0 ? categoryNetTotal + netAmountIncome : categoryNetTotal;
    const otherTaxableIncome = Math.max(partner.otherTaxableIncome || 0, 0);
    const alimonyDeduction =
        Math.max(partner.alimonyPaid || 0, 0) * table.alimonyDeductibleFraction;
    return {
        partner,
        activities,
        categories,
        grossIncome,
        employeeSocialSecurity,
        professionalExpenses,
        unionDuesApplied,
        netProfessionalIncome,
        netAmountIncome,
        csssBase,
        csssSubject,
        otherTaxableIncome,
        alimonyDeduction,
        taxableIncomeBeforeQuotient: clampAtZero(
            netProfessionalIncome + otherTaxableIncome - alimonyDeduction,
        ),
    };
}

/**
 * Taxable income per partner after an optional quotient transfer. Under joint assessment the
 * alimony deduction is charged first on the payer's total net income and any balance on the
 * other spouse's (art. 105, 3°).
 */
function taxableIncomes(
    incomes: readonly PartnerIncome[],
    joint: boolean,
    transfer: QuotientTransfer | undefined,
): number[] {
    const totals = incomes.map((inc) => {
        const adj =
            transfer === undefined
                ? 0
                : inc.partner.id === transfer.to
                  ? transfer.transfer
                  : inc.partner.id === transfer.from
                    ? -transfer.transfer
                    : 0;
        return adj === 0
            ? inc.netProfessionalIncome + inc.otherTaxableIncome
            : clampAtZero(inc.netProfessionalIncome + adj) + inc.otherTaxableIncome;
    });
    if (!joint || incomes.length !== 2) {
        return incomes.map((inc, i) =>
            clampAtZero((totals[i] as number) - inc.alimonyDeduction),
        );
    }
    const result = [...totals];
    const overflow = [0, 0];
    incomes.forEach((inc, i) => {
        const charged = Math.min(inc.alimonyDeduction, Math.max(result[i] as number, 0));
        result[i] = (result[i] as number) - charged;
        overflow[i] = inc.alimonyDeduction - charged;
    });
    for (const [i, j] of [
        [0, 1],
        [1, 0],
    ] as const) {
        const extra = Math.min(overflow[i] as number, Math.max(result[j] as number, 0));
        result[j] = (result[j] as number) - extra;
    }
    return result.map(clampAtZero);
}

interface TaxStep {
    taxables: number[];
    brackets: BracketTax[];
    allocations: ExemptionAllocation[];
    exemptionBenefits: number[];
    pitAfterExemption: number[];
    combined: number;
    issues: HouseholdTaxIssue[];
    supplementTotalChildren: number;
    unusedExemption: number;
}

function computeTaxStep(
    household: BelgianTaxHouseholdV2,
    incomes: readonly PartnerIncome[],
    mode: HouseholdTaxResult["assessment"]["mode"],
    transfer: QuotientTransfer | undefined,
    table: BelgianTaxYearTable,
): TaxStep {
    const taxables = taxableIncomes(incomes, mode === "joint", transfer);
    const childcareDeducted = incomes.some((inc) =>
        isChildcareDeducted(inc.partner.reductions),
    );
    const alloc = allocateExemptions({
        mode,
        partners: incomes.map((inc, i) => {
            const p: ExemptionPartnerInput = {
                id: inc.partner.id,
                isDisabled: inc.partner.isDisabled,
                taxableIncome: taxables[i] as number,
            };
            if (inc.partner.isIsolatedParent !== undefined)
                p.isIsolatedParent = inc.partner.isIsolatedParent;
            return p;
        }),
        dependents: household.dependents,
        childcareDeducted,
        table,
    });
    const brackets: BracketTax[] = [];
    const allocations: ExemptionAllocation[] = [];
    const exemptionBenefits: number[] = [];
    const pitAfterExemption: number[] = [];
    let combined = 0;
    incomes.forEach((inc, i) => {
        const taxable = taxables[i] as number;
        const bracket = computeProgressiveTax(taxable, table.brackets);
        const allocation = alloc.allocations[inc.partner.id] as ExemptionAllocation;
        const benefit = computeExemptionBenefit(allocation.applied, table.exemptionBrackets);
        const pit = clampAtZero(bracket.total - benefit);
        brackets.push(bracket);
        allocations.push(allocation);
        exemptionBenefits.push(benefit);
        pitAfterExemption.push(pit);
        combined += pit;
    });
    return {
        taxables,
        brackets,
        allocations,
        exemptionBenefits,
        pitAfterExemption,
        combined,
        issues: alloc.issues,
        supplementTotalChildren:
            alloc.supplements.children + alloc.supplements.childUnder3,
        unusedExemption: alloc.unusedExemption,
    };
}

function sortedPartners(household: BelgianTaxHouseholdV2): HouseholdPartner[] {
    return [...household.partners].sort((a, b) => a.id.localeCompare(b.id));
}

/** Compute the household's tax for `household.taxYear`. Pure; never mutates its input. */
export function computeHouseholdTax(
    household: BelgianTaxHouseholdV2,
): HouseholdTaxResult {
    const incomeYear = household.taxYear;
    const table = getTaxTable(incomeYear);
    const assessed = deriveAssessment(household, incomeYear);
    const decision = assessed.decision;
    const issues: HouseholdTaxIssue[] = [...assessed.issues];
    const mode = decision.mode;

    const partners = sortedPartners(household).filter((p) =>
        decision.partnerIds.includes(p.id),
    );
    const incomes = partners.map((p) => computePartnerIncome(p, table, issues));

    // Own-home credit to the partner who claims it (default A, else the first assessed partner).
    const mortgagePartnerId: PartnerId | undefined = partners.some(
        (p) => p.id === (household.home.mortgageCreditPartnerId ?? "A"),
    )
        ? (household.home.mortgageCreditPartnerId ?? "A")
        : partners[0]?.id;
    // Outside a joint assessment a child is the dependant of the partner who claims it (the
    // art. 132 supplements follow the same claimant), so this year's children count for the
    // own-home credit (Walloon art. 145/46ter §2; the Flemish woonbonus +80 proxy when
    // `woonbonusChildrenAtLoanStart` is absent) only when the mortgage partner is the claimant.
    const childrenClaimantId = resolveDependentsClaimant(
        partners,
        household.dependents.claimantPartnerId,
    );
    const homeHasChildren = mode === "joint" || childrenClaimantId === mortgagePartnerId;
    const homeInputs = {
        ...household.home,
        region: household.region,
        dependentChildren: homeHasChildren ? household.dependents.children : 0,
        dependentChildrenDisabled: homeHasChildren ? (household.dependents.childrenDisabled ?? 0) : 0,
    };
    const ownHomeCreditRegime = resolveMortgageRegime(homeInputs);
    // Without the borrower's children on 1 January after the loan year, the woonbonus +80 rests
    // on this year's children of the claimant (a proxy), so say so while the +760 period runs.
    if (
        ownHomeCreditRegime === "flemish_woonbonus" &&
        mortgagePartnerId !== undefined &&
        household.home.woonbonusChildrenAtLoanStart === undefined &&
        incomeYear - (household.home.mortgageStartYear ?? 0) < 10
    ) {
        issues.push({
            code: "woonbonus_children_at_loan_start_missing",
            severity: "info",
            partnerId: mortgagePartnerId,
        });
    }
    // The claimant's taxable income before the quotient sets the woonbonus marginal rate and the
    // chèque habitat income limits, as in `computeBelgianPIT`.
    const mortgageIncome = incomes.find((inc) => inc.partner.id === mortgagePartnerId);
    const ownHomeCreditTotal = mortgageIncome
        ? computeOwnHomeCredit(homeInputs, table, ownHomeCreditRegime, {
              taxableIncome: mortgageIncome.taxableIncomeBeforeQuotient,
              marginalRatePercent: computeMarginalRate(
                  mortgageIncome.taxableIncomeBeforeQuotient,
                  table.brackets,
              ),
              incomeYear,
          })
        : 0;

    const autonomyFactor = table.regionalAutonomyFactor?.[household.region] ?? 1;
    const surchargePct = household.communalSurchargePercent;

    // Reductions and the own-home credit depend on the pre-quotient income only, so they are
    // fixed before the quotient is decided and feed the art. 88 comparison below.
    const partnerReductions = incomes.map((inc) =>
        computeTaxReductions(
            inc.partner.reductions,
            household.region,
            inc.taxableIncomeBeforeQuotient,
            table,
        ),
    );
    const partnerCredits = incomes.map(
        (inc, i) =>
            (partnerReductions[i] as TaxReductionBreakdown).total +
            (inc.partner.id === mortgagePartnerId ? ownHomeCreditTotal : 0),
    );
    // Art. 88 withholds the quotient when "the assessment" would be higher: the comparison is
    // made on the tax after reductions, the state/regional factor and the communal surcharge,
    // not on the tax after the tax-free sum alone (a partner's reductions cannot offset the tax
    // the transfer creates for the other partner).
    const finalTaxOf = (step: TaxStep): number =>
        step.pitAfterExemption.reduce((acc, pitAfter, i) => {
            const applied = Math.min(partnerCredits[i] as number, pitAfter);
            return acc + (pitAfter - applied) * autonomyFactor * (1 + surchargePct / 100);
        }, 0);

    // Marital quotient (joint assessment of two partners only).
    let quotient: MaritalQuotientResult = {
        applied: false,
        transfer: 0,
        target: 0,
        cap: table.maritalQuotientCap,
        benefit: 0,
    };
    if (mode === "joint" && incomes.length === 2) {
        const [i0, i1] = incomes as [PartnerIncome, PartnerIncome];
        const quotientPartners = [i0, i1].map((inc) => {
            const q: { id: PartnerId; netProfessionalIncome: number; birthYear?: number } = {
                id: inc.partner.id,
                netProfessionalIncome: inc.netProfessionalIncome,
            };
            if (inc.partner.birthYear !== undefined) q.birthYear = inc.partner.birthYear;
            return q;
        });
        const cap = resolveMaritalQuotientCap(quotientPartners, incomeYear, table);
        issues.push(...cap.issues);
        quotient = computeMaritalQuotient({
            partners: [quotientPartners[0]!, quotientPartners[1]!],
            rate: table.maritalQuotientRate,
            cap: cap.cap,
            evaluate: (transfer) =>
                finalTaxOf(computeTaxStep(household, incomes, mode, transfer, table)),
        });
    }
    const appliedTransfer: QuotientTransfer | undefined =
        quotient.applied && quotient.fromPartnerId && quotient.toPartnerId
            ? { from: quotient.fromPartnerId, to: quotient.toPartnerId, transfer: quotient.transfer }
            : undefined;
    const step = computeTaxStep(household, incomes, mode, appliedTransfer, table);
    issues.push(...step.issues);
    if (step.unusedExemption > 0 && step.supplementTotalChildren > 0) {
        issues.push({ code: "refundable_child_credit_not_modelled", severity: "needs_source" });
    }

    const partnerResults: PartnerTaxResult[] = incomes.map((inc, i) => {
        const id = inc.partner.id;
        const reductions = partnerReductions[i] as TaxReductionBreakdown;
        const ownHomeCredit = id === mortgagePartnerId ? ownHomeCreditTotal : 0;
        const pitAfter = step.pitAfterExemption[i] as number;
        const reductionsApplied = Math.min(reductions.total + ownHomeCredit, pitAfter);
        const federalPITAfterReductions = (pitAfter - reductionsApplied) * autonomyFactor;
        const communalSurcharge = federalPITAfterReductions * (surchargePct / 100);
        const investment = computeInvestmentSideCalc(
            inc.partner.annualDividendIncome,
            inc.partner.annualSavingsInterest,
            table,
        );
        const taxable = step.taxables[i] as number;
        return {
            partnerId: id,
            activities: inc.activities,
            categories: inc.categories,
            grossIncome: inc.grossIncome,
            employeeSocialSecurity: inc.employeeSocialSecurity,
            professionalExpenses: inc.professionalExpenses,
            unionDuesApplied: inc.unionDuesApplied,
            netProfessionalIncome: inc.netProfessionalIncome,
            otherTaxableIncome: inc.otherTaxableIncome,
            alimonyDeduction: inc.alimonyDeduction,
            taxableIncomeBeforeQuotient: inc.taxableIncomeBeforeQuotient,
            quotientAdjustment:
                appliedTransfer === undefined
                    ? 0
                    : id === appliedTransfer.to
                      ? appliedTransfer.transfer
                      : -appliedTransfer.transfer,
            taxableIncome: taxable,
            bracketTax: step.brackets[i] as BracketTax,
            exemption: step.allocations[i] as ExemptionAllocation,
            exemptionBenefit: step.exemptionBenefits[i] as number,
            pitAfterExemption: pitAfter,
            reductions,
            ownHomeCreditRegime: id === mortgagePartnerId ? ownHomeCreditRegime : "none",
            ownHomeCredit,
            reductionsApplied,
            federalPITAfterReductions,
            communalSurcharge,
            totalPIT: federalPITAfterReductions + communalSurcharge,
            specialSocialSecurityContribution: 0,
            csssSubject: inc.csssSubject,
            dividendWhtReclaim: investment.dividendWhtReclaim,
            savingsInterestTax: investment.savingsInterestTax,
            marginalRate: computeMarginalRate(taxable, table.brackets),
        };
    });

    if (
        mode === "joint" &&
        partnerResults.length === 2 &&
        partnerResults.some((p) => p.reductions.total + p.ownHomeCredit > 0)
    ) {
        issues.push({ code: "joint_reduction_allocation_unverified", severity: "needs_source" });
    }

    // CSSS (law of 30 March 1994): the household owes it when a member falls under art. 106;
    // under a joint assessment the joint scale applies to the household income (art. 107, 2°).
    let csss: HouseholdTaxResult["csss"] = { scale: "none", base: 0, total: 0 };
    if (mode === "joint" && incomes.length === 2) {
        if (incomes.some((inc) => inc.csssSubject)) {
            const base = (incomes[0] as PartnerIncome).csssBase + (incomes[1] as PartnerIncome).csssBase;
            const total = evaluateCsssScale(base, table.csssTableJoint);
            csss = { scale: "joint", base, total };
            incomes.forEach((inc, i) => {
                (partnerResults[i] as PartnerTaxResult).specialSocialSecurityContribution =
                    base > 0 ? (total * inc.csssBase) / base : 0;
            });
        }
    } else {
        let base = 0;
        let total = 0;
        incomes.forEach((inc, i) => {
            if (!inc.csssSubject) return;
            const own = evaluateCsssScale(inc.csssBase, table.csssTable);
            (partnerResults[i] as PartnerTaxResult).specialSocialSecurityContribution = own;
            base += inc.csssBase;
            total += own;
        });
        if (incomes.some((inc) => inc.csssSubject)) csss = { scale: "single", base, total };
    }

    const propertyTaxEstimate = computePropertyTaxEstimate(
        { ...household.home, region: household.region },
        table,
    );

    let grossIncome = 0;
    let employeeSocialSecurity = 0;
    let professionalExpenses = 0;
    let netProfessionalIncome = 0;
    let taxableIncome = 0;
    let federalPITBeforeExemption = 0;
    let personalExemptionBenefit = 0;
    let taxReductions = 0;
    let federalPITAfterReductions = 0;
    let communalSurcharge = 0;
    let dividendWhtReclaim = 0;
    let savingsInterestTax = 0;
    for (const p of partnerResults) {
        // Already-net activities carry no gross; their net amount is the cash the household has.
        grossIncome +=
            p.grossIncome +
            p.otherTaxableIncome +
            sum(
                p.activities.filter((a) => a.kind === "net_professional_amount"),
                (a) => a.netProfessionalIncome,
            );
        employeeSocialSecurity += p.employeeSocialSecurity;
        professionalExpenses += p.professionalExpenses;
        netProfessionalIncome += p.netProfessionalIncome;
        taxableIncome += p.taxableIncome;
        federalPITBeforeExemption += p.bracketTax.total;
        personalExemptionBenefit += p.exemptionBenefit;
        taxReductions += p.exemptionBenefit + p.reductionsApplied;
        federalPITAfterReductions += p.federalPITAfterReductions;
        communalSurcharge += p.communalSurcharge;
        dividendWhtReclaim += p.dividendWhtReclaim;
        savingsInterestTax += p.savingsInterestTax;
    }
    const totalPIT = federalPITAfterReductions + communalSurcharge;
    const totalTaxBurden =
        totalPIT + employeeSocialSecurity + csss.total + propertyTaxEstimate;

    return {
        engineVersion: 2,
        incomeYear,
        assessment: decision,
        partners: partnerResults,
        quotient,
        csss,
        propertyTaxEstimate,
        totals: {
            grossIncome,
            employeeSocialSecurity,
            professionalExpenses,
            netProfessionalIncome,
            taxableIncome,
            federalPITBeforeExemption,
            personalExemptionBenefit,
            taxReductions,
            federalPITAfterReductions,
            communalSurcharge,
            totalPIT,
            specialSocialSecurityContribution: csss.total,
            propertyTaxEstimate,
            totalTaxBurden,
            netTakeHome: grossIncome - totalTaxBurden,
            dividendWhtReclaim,
            savingsInterestTax,
            refundableChildCredit: 0,
        },
        issues,
    };
}

/**
 * Partners whose income is itemised in the single-profile view: partner A, and any partner with
 * an activity other than a `net_professional_amount`, other income or alimony. A partner who only
 * carries an already-net amount (the legacy `spouseProfessionalIncome`) enters the tax lines but
 * not the income lines, exactly as in the v1 `married_joint` calculation.
 */
function isIncomeLinePartner(p: PartnerTaxResult): boolean {
    return (
        p.partnerId === "A" ||
        p.activities.some((a) => a.kind !== "net_professional_amount") ||
        p.otherTaxableIncome > 0 ||
        p.alimonyDeduction > 0
    );
}

function sum<T>(items: readonly T[], pick: (item: T) => number): number {
    let total = 0;
    for (const item of items) total += pick(item);
    return total;
}

/**
 * Project a household result onto the v1 `BelgianTaxCalculation` shape (same fields, same
 * breakdown labels and order). Income lines (gross, contributions, expenses, taxable income,
 * exemption amount, marginal rate) cover the income-line partners; tax lines are household
 * totals. For one partner with one activity this equals `computeBelgianPIT` on the projected
 * profile.
 */
export function toBelgianTaxCalculation(
    result: HouseholdTaxResult,
    household: BelgianTaxHouseholdV2,
): BelgianTaxCalculation {
    const table = getTaxTable(result.incomeYear);
    const lines = result.partners.filter(isIncomeLinePartner);
    const all = result.partners;

    let gross = 0;
    for (const p of lines) gross += p.grossIncome + p.otherTaxableIncome;
    // Partners outside the income lines (an already-net legacy spouse amount) still count in
    // the household gross that `netTakeHome` and `effectiveRate` are based on, as in v1.
    let spouseIncome = 0;
    for (const p of all) {
        if (lines.includes(p)) continue;
        spouseIncome +=
            sum(p.activities, (a) => a.netProfessionalIncome) + p.otherTaxableIncome;
    }
    const householdGross = gross + spouseIncome;
    const employeeSS = sum(all, (p) => p.employeeSocialSecurity);
    const netAfterSS = gross - employeeSS;
    const profExpenses = sum(all, (p) => p.professionalExpenses);
    const otherDeductions = sum(all, (p) => p.alimonyDeduction);
    const appliedUnionDues = sum(all, (p) => p.unionDuesApplied);
    const lineTaxable = lines.map((p) => {
        const netAmount = sum(
            p.activities.filter((a) => a.kind === "net_professional_amount"),
            (a) => a.netProfessionalIncome,
        );
        return netAmount > 0
            ? clampAtZero(
                  p.netProfessionalIncome - netAmount + p.otherTaxableIncome - p.alimonyDeduction,
              )
            : p.taxableIncomeBeforeQuotient;
    });
    const taxableIncome = sum(lineTaxable, (t) => t);

    const bracketTax = all.reduce<BracketTax>(
        (acc, p) => addBracketTax(acc, p.bracketTax),
        { b1: 0, b2: 0, b3: 0, b4: 0, total: 0 },
    );
    const personalExemptionBenefit = sum(all, (p) => p.exemptionBenefit);
    const appliedTaxCredits = sum(all, (p) => p.reductionsApplied);
    const ownHomeCredit = sum(all, (p) => p.ownHomeCredit);
    const ownHomeCreditRegime =
        all.find((p) => p.ownHomeCreditRegime !== "none")?.ownHomeCreditRegime ?? "none";
    const serviceVoucherCredit = sum(all, (p) => p.reductions.serviceVouchers);
    const federalPITAfterReductions = sum(all, (p) => p.federalPITAfterReductions);
    const communalSurcharge = sum(all, (p) => p.communalSurcharge);
    const specialSS = result.csss.total;
    const propertyTaxEstimate = result.propertyTaxEstimate;
    const totalPIT = federalPITAfterReductions + communalSurcharge;
    const totalTaxBurden = totalPIT + employeeSS + specialSS + propertyTaxEstimate;
    const effectiveRate = householdGross > 0 ? (totalTaxBurden / householdGross) * 100 : 0;
    let marginalRate = table.brackets[0].rate * 100;
    for (const t of lineTaxable) {
        marginalRate = Math.max(marginalRate, computeMarginalRate(t, table.brackets));
    }
    const netTakeHome = householdGross - totalTaxBurden;
    const federalPITBeforeExemption = bracketTax.total;
    const maritalQuotientTransfer = result.quotient.applied ? result.quotient.transfer : 0;
    const maritalQuotientBenefit = result.quotient.applied ? result.quotient.benefit : 0;

    const breakdown = buildCalculationBreakdown({
        table,
        grossIncome: gross,
        spouseProfessionalIncome: spouseIncome,
        employeeSocialSecurity: employeeSS,
        netIncomeAfterSS: netAfterSS,
        professionalExpenses: profExpenses,
        showAlimonyRow: household.partners.some((p) => !!p.alimonyPaid),
        alimonyDeduction: otherDeductions,
        unionDuesApplied: appliedUnionDues,
        taxableIncome,
        bracketTax,
        maritalQuotientTransfer,
        maritalQuotientBenefit,
        personalExemptionBenefit,
        ownHomeCredit,
        serviceVoucherCredit,
        federalTaxCredits: appliedTaxCredits,
        federalPITBeforeExemption,
        federalPITAfterReductions,
        communalSurchargePercent: household.communalSurchargePercent,
        communalSurcharge,
        specialSocialSecurityContribution: specialSS,
        propertyTaxEstimate,
        netTakeHome,
    });

    return {
        grossIncome: gross,
        spouseProfessionalIncome: spouseIncome,
        householdGrossIncome: householdGross,
        employeeSocialSecurity: employeeSS,
        specialSocialSecurityContribution: specialSS,
        personalExemptionAmount: sum(lines, (p) => p.exemption.ownTotal),
        netIncomeAfterSS: netAfterSS,
        professionalExpenses: profExpenses,
        otherDeductionsTotal: otherDeductions,
        deductions: {
            alimonyPaid: otherDeductions,
            personalPensionContributions: 0,
            lifeInsurancePremiums: 0,
            mortgageInterestPaid: Math.max(household.home.mortgageInterestPaid || 0, 0),
            charitableDonations: 0,
            childcareCosts: 0,
            unionDues: appliedUnionDues,
            medicalExpenses: 0,
        },
        taxableIncome,
        federalPITBracket1: bracketTax.b1,
        federalPITBracket2: bracketTax.b2,
        federalPITBracket3: bracketTax.b3,
        federalPITBracket4: bracketTax.b4,
        federalPITBeforeExemption,
        personalExemptionBenefit,
        federalTaxCredits: appliedTaxCredits,
        ownHomeCreditRegime,
        ownHomeCredit,
        taxReductions: personalExemptionBenefit + appliedTaxCredits,
        federalPITAfterReductions,
        communalSurcharge,
        totalPIT,
        totalTaxBurden,
        effectiveRate,
        marginalRate,
        netTakeHome,
        monthlyTaxReserve: totalPIT / 12,
        propertyTaxEstimate,
        dividendWhtReclaim: sum(all, (p) => p.dividendWhtReclaim),
        savingsInterestTax: sum(all, (p) => p.savingsInterestTax),
        maritalQuotientTransfer,
        maritalQuotientBenefit,
        serviceVoucherCredit,
        breakdown,
    };
}
