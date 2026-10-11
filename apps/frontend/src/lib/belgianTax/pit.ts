/**
 * Belgian Personal Income Tax (PIT) calculator.
 *
 * Implements:
 *  - Federal progressive brackets (year-aware)
 *  - Personal exemption ("quotité du revenu exempté") applied at the lowest brackets first
 *    via a dedicated exemption-bracket table (CIR-92 art. 134 §3).
 *  - Professional expense deduction (lump-sum or actual; union dues count as actual
 *    professional expenses, so they only deduct under the 'actual' method)
 *  - Deductions: alimony (80%)
 *  - Tax credits ("réductions d'impôt"): pension savings, life insurance, group insurance,
 *    charitable donations, childcare, domestic personnel, all with statutory caps
 *  - Regional own-home credit (Flemish woonbonus pre-2020 / Walloon chèque habitat post-2016).
 *    Brussels and post-2020 Flemish regimes are not modeled.
 *  - Communal surcharge applied to federal PIT after credits
 *  - Employee social security + special social security contribution
 *  - Property tax estimate (separate, informational)
 *  - Investment income side calc: dividend WHT reclaim + savings interest tax
 *
 * Limitations / not modeled:
 *  - Medical expenses: NOT deductible in Belgian PIT (no general medical deduction
 *    exists); the profile field is kept for record-keeping/export only.
 *  - Group-insurance credit (30%) is applied without a statutory ceiling — the
 *    80%-rule interaction is not modeled, so large contributions overstate the credit.
 *  - Marital quotient / married joint filing income split
 *  - Brussels post-2017 stamp-duty rebate (one-time, not annual)
 *  - Flemish post-2020 mortgages (no successor regime — capital owners only)
 *  - Securities account tax (TACR) — values exposed via constants for UI use
 *  - Reynders tax on accumulating bond fund redemptions
 *  - Foreign tax credit (DBI-RDT) on foreign dividends
 *  - Speculative capital gains regime
 */

import type {
    BelgianTaxProfile,
    BelgianTaxCalculation,
    BracketTax,
} from "./types";
import { getTaxTable, type BelgianTaxYearTable } from "./constants";
import {
    computeEmployeeSocialSecurity,
    computeSpecialSocialSecurityContribution,
} from "./socialSecurity";
import { computePropertyTaxEstimate } from "./propertyTax";
import {
    addBracketTax,
    clampAtZero,
    computeExemptionBenefit,
    computeInvestmentSideCalc,
    computeMarginalRate,
    computeOwnHomeCredit,
    computeProfessionalExpenseClaim,
    computeProgressiveTax,
    computeTaxReductions,
    isChildcareDeducted,
    resolveMortgageRegime,
    type ForfaitCategory,
} from "./personPit";

/** Art. 51 forfait category of the single-profile employment type. */
function forfaitCategoryForProfile(profile: BelgianTaxProfile): ForfaitCategory {
    switch (profile.employmentType) {
        case "employee":
        case "civil_servant":
            return "remuneration";
        case "director":
            return "director";
        case "self_employed":
            return (profile.selfEmployedIncomeKind ?? "profits") === "profits"
                ? "profits"
                : "fees";
        default:
            return "none";
    }
}

function computeProfessionalExpenses(
    profile: BelgianTaxProfile,
    table: BelgianTaxYearTable,
    employeeSocialSecurity: number,
): number {
    // Union dues are professional expenses (CIR-92 art. 49) — deductible only when itemizing
    // actual expenses, never on top of the lump-sum forfait. Users who already counted them
    // inside actualProfessionalExpenses should leave the dedicated field at 0 (see the
    // profile-step hint). The forfait base is the gross income "vooraf verminderd met" the
    // art. 52, 7° social contributions (art. 51 al. 1; FPS Finance, Beroepsinkomen:
    // "brutoberoepsinkomen (verminderd met bijdragen)"), so the employee contribution comes off
    // first.
    return computeProfessionalExpenseClaim(
        {
            category: forfaitCategoryForProfile(profile),
            grossAfterContributions: Math.max(
                Math.max(profile.grossAnnualIncome || 0, 0) -
                    Math.max(employeeSocialSecurity, 0),
                0,
            ),
            method: profile.professionalExpenseMethod,
            actualAmount: profile.actualProfessionalExpenses,
            unionDues: profile.unionDues,
        },
        table,
    );
}

function computePersonalExemption(
    profile: BelgianTaxProfile,
    table: BelgianTaxYearTable,
): number {
    // Handicapped dependents count for TWO on the supplement scale (PwC; CIR-92 arts.
    // 132 4° / 136). We bump the EFFECTIVE child / other-dependent count by the
    // disabled-subset count so the scale lookup lands one tier higher per disabled person.
    const rawChildren = Math.max(profile.dependentChildren || 0, 0);
    const disabledChildren = Math.min(
        Math.max(profile.dependentChildrenDisabled || 0, 0),
        rawChildren,
    );
    const childCount = rawChildren + disabledChildren;

    const baseChild =
        childCount <= 4
            ? (table.dependentChildExemptionIncreases[childCount] ?? 0)
            : (table.dependentChildExemptionIncreases[4] ?? 0) +
              (childCount - 4) * table.extraChildExemptionFromFifth;

    // CIR-92 art. 132bis (PwC: "if no childcare expenses deducted"): the child-under-3
    // supplement is forfeited when the taxpayer also claims the childcare reduction.
    // The two are mutually exclusive — taxpayer picks whichever is more beneficial.
    const childcareDeducted = isChildcareDeducted(profile);
    const childUnder3 = childcareDeducted
        ? 0
        : Math.max(profile.dependentChildrenUnder3 || 0, 0) *
          table.childUnder3Supplement;

    const rawOtherDep = Math.max(profile.dependentOtherPersons || 0, 0);
    const disabledOther = Math.min(
        Math.max(profile.dependentOtherPersonsDisabled || 0, 0),
        rawOtherDep,
    );
    const otherDep =
        (rawOtherDep + disabledOther) * table.otherDependentExemption;

    const disabilitySupplement =
        (profile.isDisabled ? table.disabledSupplement : 0) +
        (profile.isSpouseDisabled ? table.disabledSupplement : 0);

    const isolatedParentSupplement =
        profile.isIsolatedParent && childCount > 0
            ? table.isolatedParentSupplement
            : 0;

    return (
        table.basicPersonalExemption +
        baseChild +
        childUnder3 +
        otherDep +
        disabilitySupplement +
        isolatedParentSupplement
    );
}

interface MaritalQuotientOutcome {
    /** Income transferred from earner to spouse (0 when not applicable). */
    transfer: number;
    /** Earner's taxable income after transfer. */
    earnerTaxable: number;
    /** Spouse's taxable income after transfer. */
    spouseTaxable: number;
    /** Combined per-bracket PIT after splitting. */
    bracketTax: BracketTax;
    /** Combined exemption benefit (earner full exemption + spouse basic exemption). */
    exemptionBenefit: number;
    /** Combined PIT after exemption. */
    pitAfterExemption: number;
    /** Tax saving vs. the single-filer calculation (0 if quotient is not beneficial). */
    benefit: number;
}

/**
 * Apply the marital quotient ("huwelijksquotiënt" / "quotient conjugal", CIR-92 art. 87–88).
 *
 * For married / legal-cohabiting joint filers, up to 30% of the higher-earner's professional
 * income (capped per year) is reallocated to the lower-earning spouse, who is then taxed on
 * that allocation separately. The benefit shows up when the spouse's bracket is lower.
 *
 * Returns the "no-quotient" baseline when the filing is single or when applying the quotient
 * would not reduce tax.
 */
function applyMaritalQuotient(
    earnerTaxableIn: number,
    profile: BelgianTaxProfile,
    table: BelgianTaxYearTable,
    singleBracketTax: BracketTax,
    singleExemptionBenefit: number,
    singlePitAfterExemption: number,
    personalExemptionTotal: number,
): MaritalQuotientOutcome {
    const single: MaritalQuotientOutcome = {
        transfer: 0,
        earnerTaxable: earnerTaxableIn,
        spouseTaxable: 0,
        bracketTax: singleBracketTax,
        exemptionBenefit: singleExemptionBenefit,
        pitAfterExemption: singlePitAfterExemption,
        benefit: 0,
    };
    if (profile.filingStatus !== "married_joint") return single;

    // Art. 126 §1 / art. 130: under joint assessment each spouse's income is taxed in their own
    // name (décumul), so the spouse's own professional income carries its own progressive tax
    // and basic exemption even when no quotient is transferred. The no-quotient baseline is
    // therefore the sum of both spouses' taxes, not the earner's tax alone.
    const spouseTaxableIn = Math.max(profile.spouseProfessionalIncome || 0, 0);
    const spouseOwnBracket = computeProgressiveTax(spouseTaxableIn, table.brackets);
    const spouseOwnExBenefit = computeExemptionBenefit(
        Math.min(table.basicPersonalExemption, spouseTaxableIn),
        table.exemptionBrackets,
    );
    const spouseOwnPitAfter = clampAtZero(spouseOwnBracket.total - spouseOwnExBenefit);
    const baseline: MaritalQuotientOutcome = {
        ...single,
        spouseTaxable: spouseTaxableIn,
        bracketTax: addBracketTax(singleBracketTax, spouseOwnBracket),
        exemptionBenefit: singleExemptionBenefit + spouseOwnExBenefit,
        pitAfterExemption: singlePitAfterExemption + spouseOwnPitAfter,
    };

    const household = earnerTaxableIn + spouseTaxableIn;
    if (household <= 0) return baseline;

    // WIB 92 art. 87 (spouse without professional income): 30% of the earner's income, capped.
    // Art. 88 (spouse below 30%): the transfer tops the spouse up so that own income PLUS the
    // transferred part reaches 30% of the household total, "doch niet hoger dan" the cap —
    // the cap bounds the SUM, not the transfer. Both articles share one indexed cap
    // (arts 87 al. 2 and 88 al. 1 in the FPS indexation notices).
    const target = Math.min(
        household * table.maritalQuotientRate,
        table.maritalQuotientCap,
    );
    const transfer = Math.max(0, target - spouseTaxableIn);
    if (transfer <= 0) return baseline;

    const earnerTaxable = clampAtZero(earnerTaxableIn - transfer);
    const spouseTaxable = spouseTaxableIn + transfer;

    const earnerBracket = computeProgressiveTax(earnerTaxable, table.brackets);
    const earnerExBenefit = computeExemptionBenefit(
        Math.min(personalExemptionTotal, earnerTaxable),
        table.exemptionBrackets,
    );
    const earnerPitAfter = clampAtZero(earnerBracket.total - earnerExBenefit);

    // Spouse gets the basic personal exemption only — kids/disability supplements stay with the
    // taxpayer who claimed them. (Some scenarios split supplements differently; out of scope.)
    const spouseBracket = computeProgressiveTax(spouseTaxable, table.brackets);
    const spouseExBenefit = computeExemptionBenefit(
        Math.min(table.basicPersonalExemption, spouseTaxable),
        table.exemptionBrackets,
    );
    const spousePitAfter = clampAtZero(spouseBracket.total - spouseExBenefit);

    const combinedPitAfter = earnerPitAfter + spousePitAfter;
    // Marital quotient is automatic — applied only when it lowers the household's total tax
    // compared with taxing each spouse's own income (art. 88 al. 2).
    if (combinedPitAfter >= baseline.pitAfterExemption) return baseline;

    return {
        transfer,
        earnerTaxable,
        spouseTaxable,
        bracketTax: addBracketTax(earnerBracket, spouseBracket),
        exemptionBenefit: earnerExBenefit + spouseExBenefit,
        pitAfterExemption: combinedPitAfter,
        benefit: baseline.pitAfterExemption - combinedPitAfter,
    };
}

export function computeBelgianPIT(
    profile: BelgianTaxProfile,
): BelgianTaxCalculation {
    const table = getTaxTable(profile.taxYear);

    // 1. Gross income (salary + other taxable income)
    const grossSalary = Math.max(profile.grossAnnualIncome || 0, 0);
    const otherIncome = Math.max(profile.otherTaxableIncome || 0, 0);
    const gross = grossSalary + otherIncome;

    // 2. Employee social security
    const employeeSS = computeEmployeeSocialSecurity(profile, table);
    const netAfterSS = gross - employeeSS;

    // 3. Professional expense deduction
    const profExpenses = computeProfessionalExpenses(profile, table, employeeSS);

    // 4. True deductions from taxable basis: alimony (CIR-92 art. 104; 80% up to 2024,
    //    70% in 2025, 60% in 2026 — `table.alimonyDeductibleFraction`).
    //    Pension, life insurance, donations, childcare, domestic help, group insurance =
    //    tax credits, applied below — NOT subtracted from taxable basis.
    //    Union dues deduct only inside ACTUAL professional expenses (handled in
    //    computeProfessionalExpenses); medical expenses are not deductible at all
    //    in Belgian PIT — both previously deducted here and understated the tax.
    const cappedAlimony =
        Math.max(profile.alimonyPaid || 0, 0) * table.alimonyDeductibleFraction;
    const appliedUnionDues =
        profile.professionalExpenseMethod === "actual"
            ? Math.max(profile.unionDues || 0, 0)
            : 0;

    const otherDeductions = cappedAlimony;

    const taxableIncome = clampAtZero(
        netAfterSS - profExpenses - otherDeductions,
    );

    // Net taxable PROFESSIONAL income — used as the basis for the special social security
    // contribution (CSSS). Statutorily this excludes non-professional income (rental,
    // dividends, etc.), even though those items enter `taxableIncome` for PIT bracket purposes.
    const netTaxableProfessional = clampAtZero(
        grossSalary - employeeSS - profExpenses,
    );

    // 5. Federal PIT on full taxable income (progressive brackets).
    const singleBracketTax = computeProgressiveTax(
        taxableIncome,
        table.brackets,
    );

    // 6. Personal exemption (quotité du revenu exempté) applied at the LOWEST brackets first
    //    via the dedicated exemption-bracket table (CIR-92 art. 134 §3).
    const personalExemptionTotal = computePersonalExemption(profile, table);
    const exemptionAmount = Math.min(personalExemptionTotal, taxableIncome);
    const singleExemptionBenefit = computeExemptionBenefit(
        exemptionAmount,
        table.exemptionBrackets,
    );

    const singlePitAfterExemption = clampAtZero(
        singleBracketTax.total - singleExemptionBenefit,
    );

    // 6b. Marital quotient (CIR-92 art. 87–88). When `filingStatus === 'married_joint'` and the
    //     spouse's professional income is materially below the earner's, up to 30% of household
    //     income (capped) is reallocated to the spouse and taxed in their own name. Returns the
    //     baseline when filing is single or when applying the quotient does not reduce tax.
    const quotient = applyMaritalQuotient(
        taxableIncome,
        profile,
        table,
        singleBracketTax,
        singleExemptionBenefit,
        singlePitAfterExemption,
        personalExemptionTotal,
    );

    const pitBeforeExemption: BracketTax = quotient.bracketTax;
    const personalExemptionBenefit = quotient.exemptionBenefit;
    const pitAfterExemption = quotient.pitAfterExemption;

    // 7. Federal tax credits (réductions d'impôt) and the regional service-voucher credit.
    //    Donations are capped at 10% of the (pre-quotient) taxable income.
    const reductions = computeTaxReductions(
        profile,
        profile.region,
        taxableIncome,
        table,
    );
    const serviceVoucherCredit = reductions.serviceVouchers;

    // Regional own-home credit (Flemish woonbonus / Walloon chèque habitat).
    const ownHomeCreditRegime = resolveMortgageRegime(profile);
    const ownHomeCredit = computeOwnHomeCredit(
        profile,
        table,
        ownHomeCreditRegime,
    );

    const totalTaxCredits = reductions.total + ownHomeCredit;

    // 8. Federal PIT after credits (cannot go below zero).
    const appliedTaxCredits = Math.min(totalTaxCredits, pitAfterExemption);
    const federalPITBeforeAutonomy = pitAfterExemption - appliedTaxCredits;

    // 8b. Regional autonomy adjustment (federal 24.95% release with regional add-back).
    // Net effect ≈ 0.49% saving — calibrated from PwC AY 2026 sample. Defaults to 1.0
    // when the region's factor is missing.
    const autonomyFactor = table.regionalAutonomyFactor?.[profile.region] ?? 1;
    const federalPITAfterReductions = federalPITBeforeAutonomy * autonomyFactor;

    // 9. Communal surcharge applied to federal PIT after reductions.
    const communalSurcharge =
        federalPITAfterReductions * (profile.communalSurchargePercent / 100);

    // 10. Special social security contribution. Law of 30 March 1994 art. 107, 2°: under a
    //     joint assessment the base is the HOUSEHOLD income (sum of both spouses' net income,
    //     before the marital quotient). Non-professional income (rental, dividends) is excluded
    //     from this base in the current single-profile model; the spouse's professional income
    //     is the only spouse figure the profile carries.
    const csssBase =
        profile.filingStatus === "married_joint"
            ? netTaxableProfessional +
              Math.max(profile.spouseProfessionalIncome || 0, 0)
            : netTaxableProfessional;
    const specialSS = computeSpecialSocialSecurityContribution(
        profile,
        csssBase,
        table,
    );

    // 11. Property tax (informational, not part of PIT).
    const propertyTaxEstimate = computePropertyTaxEstimate(profile, table);

    // 12. Investment income side calc.
    const { dividendWhtReclaim, savingsInterestTax } = computeInvestmentSideCalc(
        profile.annualDividendIncome,
        profile.annualSavingsInterest,
        table,
    );

    // 13. Aggregate totals — distinct meanings, no double-counting.
    //     Under a joint assessment `totalPIT` and the CSSS cover both spouses, so the
    //     household aggregates (gross, net take-home, effective rate) include the spouse's
    //     professional income as well; the per-step rows above stay the earner's.
    const spouseIncome =
        profile.filingStatus === "married_joint"
            ? Math.max(profile.spouseProfessionalIncome || 0, 0)
            : 0;
    const householdGross = gross + spouseIncome;
    const totalPIT = federalPITAfterReductions + communalSurcharge;
    const totalTaxBurden =
        totalPIT + employeeSS + specialSS + propertyTaxEstimate;
    const effectiveRate =
        householdGross > 0 ? (totalTaxBurden / householdGross) * 100 : 0;

    const marginalRate = computeMarginalRate(taxableIncome, table.brackets);

    const netTakeHome = householdGross - totalTaxBurden;
    const monthlyTaxReserve = totalPIT / 12;

    const federalPITBeforeExemption = pitBeforeExemption.total;

    const breakdown = [
        { label: "Gross Income", amount: gross },
        ...(spouseIncome > 0
            ? [{ label: "Spouse professional income", amount: spouseIncome }]
            : []),
        {
            label: "Employee Social Security",
            amount: -employeeSS,
            rate: table.employeeSSRate * 100,
        },
        { label: "Net after Social Security", amount: netAfterSS },
        { label: "Professional Expenses Deduction", amount: -profExpenses },
        ...(profile.alimonyPaid
            ? [
                  {
                      label: `Alimony paid (${Math.round(table.alimonyDeductibleFraction * 100)}% deductible)`,
                      amount: -cappedAlimony,
                  },
              ]
            : []),
        ...(appliedUnionDues > 0
            ? [
                  {
                      label: "Union dues (within actual professional expenses)",
                      amount: -appliedUnionDues,
                  },
              ]
            : []),
        { label: "Taxable Income", amount: taxableIncome },
        // One breakdown row per non-empty bracket; the top bracket is open-ended.
        ...table.brackets.flatMap((br, i) => {
            const amount =
                pitBeforeExemption[`b${i + 1}` as "b1" | "b2" | "b3" | "b4"];
            if (amount <= 0) return [];
            const isTop = i === table.brackets.length - 1;
            return [
                {
                    // `label` stays English: this array is a calculation result, not
                    // a view model, and pit.ts has no access to `t`. Consumers that
                    // render a bracket row translate via `bracketNumber` (see
                    // ExportDialog) — the ordinal is carried explicitly because
                    // empty brackets are skipped, so a consumer's array index is not
                    // the bracket number.
                    label: `Bracket ${i + 1} (${br.rate * 100}%)`,
                    bracketNumber: i + 1,
                    amount: -amount,
                    rate: br.rate * 100,
                    bracket: isTop ? `€${br.from}+` : `€${br.from} – €${br.to}`,
                },
            ];
        }),
        ...(quotient.transfer > 0
            ? [
                  {
                      label: `Marital quotient transferred to spouse`,
                      amount: -quotient.transfer,
                  },
              ]
            : []),
        ...(quotient.benefit > 0
            ? [
                  {
                      label: "Marital quotient tax saving",
                      amount: -quotient.benefit,
                  },
              ]
            : []),
        ...(personalExemptionBenefit > 0
            ? [
                  {
                      label: "Personal exemption benefit",
                      amount: -personalExemptionBenefit,
                  },
              ]
            : []),
        ...(ownHomeCredit > 0
            ? [{ label: "Own-home credit", amount: -ownHomeCredit }]
            : []),
        ...(serviceVoucherCredit > 0
            ? [
                  {
                      label: "Service-voucher credit (dienstencheques)",
                      amount: -serviceVoucherCredit,
                  },
              ]
            : []),
        ...(appliedTaxCredits > 0
            ? [
                  {
                      label: "Tax Credits (reductions)",
                      amount: -appliedTaxCredits,
                  },
              ]
            : []),
        // Position total, not a deduction step: gross PIT before the exemption
        // benefit and credits listed above. (Was mislabeled "before credits".)
        {
            label: "Federal PIT (before exemption)",
            amount: -federalPITBeforeExemption,
        },
        {
            label: "Federal PIT (after credits)",
            amount: -federalPITAfterReductions,
        },
        {
            label: `Communal Surcharge (${profile.communalSurchargePercent}%)`,
            amount: -communalSurcharge,
            rate: profile.communalSurchargePercent,
        },
        ...(specialSS > 0
            ? [
                  {
                      label: "Special Social Security Contribution",
                      amount: -specialSS,
                  },
              ]
            : []),
        // Property tax is informational for PIT but part of totalTaxBurden, so it
        // must appear as a row — without it the visible rows missed Net Take-Home
        // by exactly this amount.
        ...(propertyTaxEstimate > 0
            ? [
                  {
                      label: "Property Tax (estimate)",
                      amount: -propertyTaxEstimate,
                  },
              ]
            : []),
        { label: "Net Take-Home", amount: netTakeHome },
    ];

    return {
        grossIncome: gross,
        spouseProfessionalIncome: spouseIncome,
        householdGrossIncome: householdGross,
        employeeSocialSecurity: employeeSS,
        specialSocialSecurityContribution: specialSS,
        personalExemptionAmount: personalExemptionTotal,
        netIncomeAfterSS: netAfterSS,
        professionalExpenses: profExpenses,
        otherDeductionsTotal: otherDeductions,
        deductions: {
            alimonyPaid: cappedAlimony,
            personalPensionContributions: 0,
            lifeInsurancePremiums: 0,
            mortgageInterestPaid: Math.max(
                profile.mortgageInterestPaid || 0,
                0,
            ),
            charitableDonations: 0,
            childcareCosts: 0,
            // Applied amounts, not raw profile inputs: union dues only deduct under
            // the actual-expense method; medical expenses are never deductible.
            unionDues: appliedUnionDues,
            medicalExpenses: 0,
        },
        taxableIncome,
        federalPITBracket1: pitBeforeExemption.b1,
        federalPITBracket2: pitBeforeExemption.b2,
        federalPITBracket3: pitBeforeExemption.b3,
        federalPITBracket4: pitBeforeExemption.b4,
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
        monthlyTaxReserve,
        propertyTaxEstimate,
        dividendWhtReclaim,
        savingsInterestTax,
        maritalQuotientTransfer: quotient.transfer,
        maritalQuotientBenefit: quotient.benefit,
        serviceVoucherCredit,
        breakdown,
    };
}
