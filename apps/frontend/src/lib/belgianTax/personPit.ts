/**
 * Per-person Belgian PIT building blocks shared by the single-profile engine (`pit.ts`) and the
 * household engine (`household.ts`). Every function here works on one taxpayer's figures; the
 * household engine calls them once per partner. Rule sources are listed in
 * docs/reference/belgian-tax-rule-matrix.md.
 */

import type {
    BelgianRegion,
    BelgianTaxCalculation,
    BelgianTaxProfile,
    BracketTax,
    MortgageCreditRegime,
    ProfessionalExpenseMethod,
} from "./types";
import type { BelgianTaxYearTable, ExemptionBracket } from "./constants";

/**
 * Professional-expense forfait category of WIB 92 art. 51 al. 2. The cap of art. 51 al. 3
 * applies once per category ("voor het geheel van de inkomsten van eenzelfde categorie").
 *  - `remuneration`: employees and civil servants (al. 2, 1°).
 *  - `profits`: self-employed trading profits (winsten), 30% with the employee cap.
 *  - `director`: company directors, 3% (al. 2, 2°).
 *  - `fees`: liberal-profession fees (baten), degressive scale (al. 2, 4°).
 *  - `helping_spouse`: helping-spouse remuneration, 5% (al. 2, 3°).
 *  - `none`: pensions, replacement and other income without a forfait.
 */
export type ForfaitCategory =
    | "remuneration"
    | "profits"
    | "director"
    | "fees"
    | "helping_spouse"
    | "none";

export function clampAtZero(n: number): number {
    return n > 0 ? n : 0;
}

/** Progressive tax of WIB 92 art. 130 on one taxpayer's taxable income. */
export function computeProgressiveTax(
    value: number,
    brackets: BelgianTaxYearTable["brackets"],
): BracketTax {
    const result: BracketTax = { b1: 0, b2: 0, b3: 0, b4: 0, total: 0 };
    if (value <= 0) return result;

    if (value > brackets[0].from) {
        result.b1 =
            (Math.min(value, brackets[0].to) - brackets[0].from) *
            brackets[0].rate;
    }
    if (value > brackets[1].from) {
        result.b2 =
            (Math.min(value, brackets[1].to) - brackets[1].from) *
            brackets[1].rate;
    }
    if (value > brackets[2].from) {
        result.b3 =
            (Math.min(value, brackets[2].to) - brackets[2].from) *
            brackets[2].rate;
    }
    if (value > brackets[3].from) {
        result.b4 = (value - brackets[3].from) * brackets[3].rate;
    }
    result.total = result.b1 + result.b2 + result.b3 + result.b4;
    return result;
}

export function addBracketTax(a: BracketTax, b: BracketTax): BracketTax {
    return {
        b1: a.b1 + b.b1,
        b2: a.b2 + b.b2,
        b3: a.b3 + b.b3,
        b4: a.b4 + b.b4,
        total: a.total + b.total,
    };
}

/**
 * Tax on the personal exemption itself, computed from the lowest bracket upward
 * using the exemption-bracket rate table. This figure is subtracted from gross PIT.
 *
 * Per PwC's IY2025 sample calculation: 25% on the bracket-1 portion, 30% on the
 * bracket-2 overflow, then main rates above. See CIR-92 art. 134 §3.
 */
export function computeExemptionBenefit(
    exemptionAmount: number,
    brackets: ReadonlyArray<ExemptionBracket>,
): number {
    if (exemptionAmount <= 0) return 0;
    let total = 0;
    for (const b of brackets) {
        if (exemptionAmount <= b.from) break;
        const upper = Math.min(exemptionAmount, b.to);
        total += (upper - b.from) * b.rate;
    }
    return total;
}

/** Highest bracket rate (in percent) reached by `taxableIncome`. */
export function computeMarginalRate(
    taxableIncome: number,
    brackets: BelgianTaxYearTable["brackets"],
): number {
    let marginalRate = brackets[0].rate * 100;
    for (const b of brackets) {
        if (taxableIncome > b.from) marginalRate = b.rate * 100;
    }
    return marginalRate;
}

/**
 * Lump-sum forfait of WIB 92 art. 51 for one category (amounts: FPS indexation notice per
 * assessment year, table I):
 *  - al. 2, 1° + al. 3: employees, civil servants and self-employed trading profits (winsten)
 *    get 30% with the "rémunérations des travailleurs et bénéfices" cap;
 *  - al. 2, 2°: company directors get 3% with their own cap;
 *  - al. 2, 3°: helping spouses get 5% with the "conjoints aidants et profits" cap;
 *  - al. 2, 4°: liberal-profession fees (baten) get the degressive 28.7/10/5/3% scale
 *    with the "conjoints aidants et profits" cap.
 * Pensions and other replacement income carry no forfait.
 *
 * `grossAfterContributions` is the category's gross income already reduced by the art. 52, 7°
 * social contributions (art. 51 al. 1: "vooraf verminderd met voormelde bijdragen").
 */
export function computeLumpSumForfait(
    category: ForfaitCategory,
    grossAfterContributions: number,
    table: BelgianTaxYearTable,
): number {
    const gross = grossAfterContributions;
    if (category === "director") {
        return Math.min(
            gross * table.directorProfessionalExpenseRate,
            table.directorProfessionalExpenseCap,
        );
    }
    if (category === "remuneration" || category === "profits") {
        return Math.min(
            gross * table.employeeProfessionalExpenseRate,
            table.employeeProfessionalExpenseCap,
        );
    }
    if (category === "helping_spouse") {
        return Math.min(
            gross * table.helpingSpouseProfessionalExpenseRate,
            table.selfEmployedFeesExpenseCap,
        );
    }
    if (category === "fees") {
        let forfait = 0;
        for (const b of table.selfEmployedFeesExpenseBrackets) {
            if (gross <= b.from) break;
            forfait += (Math.min(gross, b.to) - b.from) * b.rate;
        }
        return Math.min(forfait, table.selfEmployedFeesExpenseCap);
    }
    return 0;
}

export interface ProfessionalExpenseClaim {
    category: ForfaitCategory;
    /** Gross income of the category minus the art. 52, 7° social contributions, clamped at 0. */
    grossAfterContributions: number;
    method: ProfessionalExpenseMethod;
    actualAmount: number;
    /**
     * Union dues counted inside an actual-expense claim. Union dues are professional expenses
     * (WIB 92 art. 49): they deduct only when itemising actual expenses, never on top of the
     * lump-sum forfait.
     */
    unionDues?: number;
}

/** Professional expenses deducted for one forfait category (actual claim or forfait). */
export function computeProfessionalExpenseClaim(
    claim: ProfessionalExpenseClaim,
    table: BelgianTaxYearTable,
): number {
    if (claim.method === "actual") {
        return (
            Math.max(claim.actualAmount || 0, 0) +
            Math.max(claim.unionDues || 0, 0)
        );
    }
    return computeLumpSumForfait(
        claim.category,
        claim.grossAfterContributions,
        table,
    );
}

/** Profile fields that feed the federal and regional tax reductions of one taxpayer. */
export type ReductionInputs = Pick<
    BelgianTaxProfile,
    | "personalPensionContributions"
    | "pensionScheme"
    | "pensionEligible"
    | "lifeInsurancePremiums"
    | "lifeInsuranceEligible"
    | "employeeGroupInsuranceContributions"
    | "employeeGroupInsuranceEligible"
    | "charitableDonations"
    | "charitableDonationsEligible"
    | "childcareCosts"
    | "childcareEligibleDays"
    | "childcareEligible"
    | "domesticHelpCosts"
    | "domesticHelpEligible"
    | "serviceVoucherCount"
    | "serviceVoucherSpend"
    | "serviceVoucherEligible"
    | "medicalExpenses"
>;

/**
 * Regional service-voucher (dienstencheques / titres-services) tax reduction, WIB 92 art. 145/21
 * in its regional versions: rate × min(expenses paid, cap per taxpayer). Rates and caps are in
 * `table.serviceVoucherRegional` (sources in constants.ts and the rule matrix).
 *
 * The expense is `serviceVoucherSpend` when set; otherwise the legacy `serviceVoucherCount` ×
 * the table's `voucherPrice`. Returns 0 when the eligibility flag is false, nothing was spent, or
 * the region has abolished the reduction for the year.
 */
export function computeServiceVoucherCredit(
    inputs: Pick<
        ReductionInputs,
        "serviceVoucherCount" | "serviceVoucherSpend" | "serviceVoucherEligible"
    >,
    region: BelgianRegion,
    table: BelgianTaxYearTable,
): number {
    if (!inputs.serviceVoucherEligible) return 0;
    const params = table.serviceVoucherRegional[region];
    if (!params || params.rate <= 0 || params.spendCap <= 0) return 0;
    const spend =
        typeof inputs.serviceVoucherSpend === "number"
            ? Math.max(inputs.serviceVoucherSpend, 0)
            : Math.max(inputs.serviceVoucherCount || 0, 0) * params.voucherPrice;
    if (spend <= 0) return 0;
    return Math.min(spend, params.spendCap) * params.rate;
}

export interface TaxReductionBreakdown {
    pension: number;
    lifeInsurance: number;
    groupInsurance: number;
    donations: number;
    childcare: number;
    domesticHelp: number;
    serviceVouchers: number;
    /** Sum of the reductions above, before the cap at the tax due (own-home credit excluded). */
    total: number;
}

/**
 * Federal tax reductions (réductions d'impôt) and the regional service-voucher reduction of one
 * taxpayer. `donationBaseIncome` is the taxable income the 10% donation ceiling refers to
 * (art. 145/33 §1 al. 4).
 */
export function computeTaxReductions(
    inputs: ReductionInputs,
    region: BelgianRegion,
    donationBaseIncome: number,
    table: BelgianTaxYearTable,
): TaxReductionBreakdown {
    const pensionCap =
        inputs.pensionScheme === "1350"
            ? table.pensionSavingsCapAlternative
            : table.pensionSavingsCapStandard;
    const pensionRate =
        inputs.pensionScheme === "1350"
            ? table.pensionSavingsRateAlternative
            : table.pensionSavingsRateStandard;
    const pension = inputs.pensionEligible
        ? Math.min(inputs.personalPensionContributions || 0, pensionCap) *
          pensionRate
        : 0;

    const lifeInsurance = inputs.lifeInsuranceEligible
        ? Math.min(inputs.lifeInsurancePremiums || 0, table.lifeInsuranceCap) *
          table.lifeInsuranceRate
        : 0;

    const groupInsurance = inputs.employeeGroupInsuranceEligible
        ? Math.max(inputs.employeeGroupInsuranceContributions || 0, 0) *
          table.groupInsuranceRate
        : 0;

    // Charitable donations: eligible donation = min(gift, 10% × net taxable income, absolute cap).
    // The €40 minimum applies to the gift itself, not to the eligible (capped) portion.
    const donationAmount = Math.max(inputs.charitableDonations || 0, 0);
    const donationNetIncomeCap = Math.max(donationBaseIncome * 0.1, 0);
    const eligibleDonation = Math.min(
        donationAmount,
        donationNetIncomeCap,
        table.charitableDonationAbsoluteCap,
    );
    const donations =
        inputs.charitableDonationsEligible &&
        donationAmount >= table.charitableDonationMin
            ? eligibleDonation * table.charitableDonationRate
            : 0;

    const childcareDayCap =
        Math.max(inputs.childcareEligibleDays || 0, 0) *
        table.childcareDailyCap;
    const childcare = inputs.childcareEligible
        ? Math.min(inputs.childcareCosts || 0, childcareDayCap) *
          table.childcareRate
        : 0;

    const domesticHelp = inputs.domesticHelpEligible
        ? Math.min(inputs.domesticHelpCosts || 0, table.domesticHelpCap) *
          table.domesticHelpRate
        : 0;

    // Service vouchers (dienstencheques / titres-services) — regional credit. Distinct from the
    // federal "domestic personnel" wage-based reduction above.
    const serviceVouchers = computeServiceVoucherCredit(inputs, region, table);

    return {
        pension,
        lifeInsurance,
        groupInsurance,
        donations,
        childcare,
        domesticHelp,
        serviceVouchers,
        total:
            pension +
            lifeInsurance +
            groupInsurance +
            donations +
            childcare +
            domesticHelp +
            serviceVouchers,
    };
}

/** True when the childcare reduction is claimed, which forfeits the child-under-3 supplement. */
export function isChildcareDeducted(
    inputs: Pick<ReductionInputs, "childcareEligible" | "childcareCosts" | "childcareEligibleDays">,
): boolean {
    return (
        !!inputs.childcareEligible &&
        (inputs.childcareCosts || 0) > 0 &&
        (inputs.childcareEligibleDays || 0) > 0
    );
}

/** Mortgage and residence fields that drive the regional own-home credit. */
export type OwnHomeCreditInputs = Pick<
    BelgianTaxProfile,
    | "mortgageIsPrimaryResidence"
    | "mortgageInterestPaid"
    | "mortgageCapitalRepaid"
    | "mortgageStartYear"
    | "mortgageRegion"
    | "region"
    | "dependentChildren"
    | "dependentChildrenDisabled"
> & {
    /**
     * Income year of the first taxable period in which the Walloon chèque habitat was claimed
     * (art. 145/46quinquies). The twenty-period window and the halving from the eleventh period
     * count from it; without it the loan year (`mortgageStartYear`) stands in.
     */
    firstQualifyingYear?: number;
    /**
     * Flemish woonbonus: dependent children of the borrower on 1 January of the year after the
     * loan year, a disabled child counted twice (arts 145/37 §2 al. 3, 145/38/2 §2 al. 3). When
     * absent, this year's dependent children stand in (see `woonbonusChildCount`).
     */
    woonbonusChildrenAtLoanStart?: number;
};

/**
 * Child count for the woonbonus +80 (Flemish arts 145/37 §2 al. 3 and 145/38/2 §2 al. 3: "drie of
 * meer dan drie kinderen ten laste ... op 1 januari van het jaar [na dat] waarin de
 * leningsovereenkomst wordt afgesloten"; disabled children "voor twee gerekend").
 * `woonbonusChildrenAtLoanStart` when set; otherwise the proxy of this year's dependent children
 * with the disabled ones counted twice.
 */
export function woonbonusChildCount(
    inputs: Pick<
        OwnHomeCreditInputs,
        "woonbonusChildrenAtLoanStart" | "dependentChildren" | "dependentChildrenDisabled"
    >,
): number {
    if (inputs.woonbonusChildrenAtLoanStart !== undefined)
        return Math.max(inputs.woonbonusChildrenAtLoanStart, 0);
    const children = Math.max(inputs.dependentChildren || 0, 0);
    const disabled = Math.min(Math.max(inputs.dependentChildrenDisabled || 0, 0), children);
    return children + disabled;
}

/** Figures of the taxpayer who claims the own-home credit. */
export interface OwnHomeCreditTaxpayer {
    /**
     * Taxable income of the period. The chèque habitat income limits refer to the art. 6
     * taxable income without non-professional movable income (art. 145/46ter §2).
     */
    taxableIncome: number;
    /** Highest art. 130 rate reached, in percent (the pre-2015 woonbonus rate). */
    marginalRatePercent: number;
    /**
     * Income year being computed. Sets the loan age; it differs from `table.year` when the year
     * runs on an approximated (nearest) table.
     */
    incomeYear: number;
}

/**
 * Resolve the regional own-home credit regime applicable to the user's mortgage.
 * Returns 'none' when the mortgage doesn't fit a modeled regime.
 */
export function resolveMortgageRegime(
    inputs: OwnHomeCreditInputs,
): MortgageCreditRegime {
    if (!inputs.mortgageIsPrimaryResidence) return "none";
    if (!inputs.mortgageInterestPaid && !inputs.mortgageCapitalRepaid)
        return "none";
    const region = inputs.mortgageRegion ?? inputs.region;
    const startYear = inputs.mortgageStartYear ?? 0;
    if (region === "flanders" && startYear > 0 && startYear < 2020)
        return "flemish_woonbonus";
    // Chèque habitat: loans "contracté à partir du 1er janvier 2016 et au plus tard le
    // 31 décembre 2024" (art. 145/46quater §1, 3°, as amended by the Walloon decree of
    // 5 Dec 2024; FPS circular 2026/C/18).
    if (region === "wallonia" && startYear >= 2016 && startYear <= 2024)
        return "walloon_cheque_habitat";
    return "none";
}

/**
 * Compute the regional own-home tax credit of the claiming taxpayer.
 *
 * Flemish woonbonus (loans signed before 2020, primary residence; WIB 92 Flemish version):
 *   - before 2015 (art. 145/37 §2): base €2,280, reduction at the taxpayer's highest art. 130
 *     rate with a 30% minimum;
 *   - 2015 (art. 145/37 §3): base €1,520, 40%;
 *   - 2016-2019 "geïntegreerde woonbonus" (art. 145/38/2): base €1,520, 40%.
 *   During the first ten taxable periods the base rises by €760, and by a further €80 when the
 *   taxpayer had three or more dependent children on 1 January of the year after the loan year,
 *   a disabled child counted twice ("De verhoging, vermeld in het tweede lid, wordt bijkomend
 *   verhoogd met 80 euro"; `woonbonusChildCount`). Expenses = interest + capital, capped at the
 *   base.
 *
 * Walloon chèque habitat (loans signed 2016-2024; art. 145/46ter as coordinated in FPS circular
 * 2026/C/18):
 *   - §2: taxable income ≤ lower limit → €1,520; between the limits → €1,520 minus 1.275% of
 *     the income above the lower limit; above the upper limit → 0. Plus €125 per dependent child
 *     (disabled children count twice), except above the upper limit.
 *   - §3: halved from the eleventh taxable period. The halving for a second home is not
 *     modelled (no input).
 *   - §4: never more than the interest, capital and premiums actually paid.
 *   - Art. 145/46quinquies: granted for twenty assessment years from the first, so nothing from
 *     the twenty-first period.
 *   The periods of §3 and art. 145/46quinquies count from `firstQualifyingYear` when set, else
 *   from the loan year (a proxy that differs when the home qualifies later, e.g. after
 *   construction); an income year before `firstQualifyingYear` gets no chèque habitat.
 *
 * All other cases (Brussels, post-2020 Flemish, post-2024 Walloon, secondary residences): 0.
 */
export function computeOwnHomeCredit(
    inputs: OwnHomeCreditInputs,
    table: BelgianTaxYearTable,
    regime: MortgageCreditRegime,
    taxpayer: OwnHomeCreditTaxpayer,
): number {
    if (regime === "none") return 0;
    const interest = Math.max(inputs.mortgageInterestPaid || 0, 0);
    const capital = Math.max(inputs.mortgageCapitalRepaid || 0, 0);
    const startYear = inputs.mortgageStartYear ?? 0;
    // Taxable periods since the loan year: 0 is the first period, 10 the eleventh.
    const loanAge = Math.max(0, taxpayer.incomeYear - startYear);

    if (regime === "flemish_woonbonus") {
        let cap: number;
        let rate: number;
        if (startYear < 2015) {
            cap = table.flemishWoonbonusBaseCap;
            rate = Math.max(
                taxpayer.marginalRatePercent / 100,
                table.flemishWoonbonusPre2015MinimumRate,
            );
        } else if (startYear === 2015) {
            cap = table.flemishWoonbonus2015BaseCap;
            rate = table.flemishWoonbonusRate;
        } else {
            cap = table.flemishIntegratedWoonbonusBaseCap;
            rate = table.flemishWoonbonusRate;
        }
        if (loanAge < 10) {
            cap += table.flemishWoonbonusExtraFirst10y;
            if (woonbonusChildCount(inputs) >= 3) cap += table.flemishWoonbonusExtraChildren;
        }
        return Math.min(interest + capital, cap) * rate;
    }

    if (regime === "walloon_cheque_habitat") {
        const income = Math.max(taxpayer.taxableIncome, 0);
        const { lower, upper } = table.walloonChequeHabitatIncomeThresholds;
        if (income > upper) return 0;
        const base =
            income <= lower
                ? table.walloonChequeHabitatBase
                : table.walloonChequeHabitatBase -
                  (income - lower) * table.walloonChequeHabitatPhaseOutRate;
        const children = Math.max(inputs.dependentChildren || 0, 0);
        const disabled = Math.min(
            Math.max(inputs.dependentChildrenDisabled || 0, 0),
            children,
        );
        const childSupplement =
            (children + disabled) * table.walloonChequeHabitatChildSupplement;
        // Periods since the first claimed one: 0 is the first, 10 the eleventh, 20 the 21st.
        // Before the first qualifying year the conditions are not met yet.
        const first = inputs.firstQualifyingYear;
        if (first !== undefined && taxpayer.incomeYear < first) return 0;
        const period = first !== undefined ? taxpayer.incomeYear - first : loanAge;
        if (period >= 20) return 0;
        let credit = Math.max(base, 0) + childSupplement;
        if (period >= 10) credit /= 2;
        return Math.min(credit, interest + capital);
    }

    return 0;
}

export interface InvestmentSideCalc {
    /** Estimated dividend WHT reclaimable through the tax return (art. 21, 14°). */
    dividendWhtReclaim: number;
    /** Tax on savings-deposit interest above the art. 21, 5° exemption. */
    savingsInterestTax: number;
}

/** Investment-income side calculation of one taxpayer. */
export function computeInvestmentSideCalc(
    annualDividendIncome: number | undefined,
    annualSavingsInterest: number | undefined,
    table: BelgianTaxYearTable,
): InvestmentSideCalc {
    const dividendIncome = Math.max(annualDividendIncome || 0, 0);
    const dividendWhtReclaim =
        Math.min(dividendIncome, table.dividendExemption) *
        table.dividendWHTRate;

    const savingsInterest = Math.max(annualSavingsInterest || 0, 0);
    const savingsInterestTax =
        Math.max(savingsInterest - table.savingsInterestExemption, 0) *
        table.savingsInterestExcessRate;
    return { dividendWhtReclaim, savingsInterestTax };
}

export interface CalculationBreakdownValues {
    table: BelgianTaxYearTable;
    grossIncome: number;
    /** Spouse's professional income counted under a joint assessment; adds a row when > 0. */
    spouseProfessionalIncome?: number;
    employeeSocialSecurity: number;
    netIncomeAfterSS: number;
    professionalExpenses: number;
    /** Show the alimony row (the single-profile engine shows it whenever alimony is entered). */
    showAlimonyRow: boolean;
    alimonyDeduction: number;
    unionDuesApplied: number;
    taxableIncome: number;
    bracketTax: BracketTax;
    maritalQuotientTransfer: number;
    maritalQuotientBenefit: number;
    personalExemptionBenefit: number;
    ownHomeCredit: number;
    serviceVoucherCredit: number;
    federalTaxCredits: number;
    federalPITBeforeExemption: number;
    federalPITAfterReductions: number;
    communalSurchargePercent: number;
    communalSurcharge: number;
    specialSocialSecurityContribution: number;
    propertyTaxEstimate: number;
    netTakeHome: number;
}

/**
 * Calculation breakdown rows of `BelgianTaxCalculation`, shared by `computeBelgianPIT` and the
 * household projection so both produce the same labels in the same order.
 */
export function buildCalculationBreakdown(
    v: CalculationBreakdownValues,
): BelgianTaxCalculation["breakdown"] {
    return [
        { label: "Gross Income", amount: v.grossIncome },
        ...((v.spouseProfessionalIncome ?? 0) > 0
            ? [{ label: "Spouse professional income", amount: v.spouseProfessionalIncome ?? 0 }]
            : []),
        {
            label: "Employee Social Security",
            amount: -v.employeeSocialSecurity,
            rate: v.table.employeeSSRate * 100,
        },
        { label: "Net after Social Security", amount: v.netIncomeAfterSS },
        { label: "Professional Expenses Deduction", amount: -v.professionalExpenses },
        ...(v.showAlimonyRow
            ? [
                  {
                      label: `Alimony paid (${Math.round(v.table.alimonyDeductibleFraction * 100)}% deductible)`,
                      amount: -v.alimonyDeduction,
                  },
              ]
            : []),
        ...(v.unionDuesApplied > 0
            ? [
                  {
                      label: "Union dues (within actual professional expenses)",
                      amount: -v.unionDuesApplied,
                  },
              ]
            : []),
        { label: "Taxable Income", amount: v.taxableIncome },
        // One breakdown row per non-empty bracket; the top bracket is open-ended.
        ...v.table.brackets.flatMap((br, i) => {
            const amount =
                v.bracketTax[`b${i + 1}` as "b1" | "b2" | "b3" | "b4"];
            if (amount <= 0) return [];
            const isTop = i === v.table.brackets.length - 1;
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
        ...(v.maritalQuotientTransfer > 0
            ? [
                  {
                      label: `Marital quotient transferred to spouse`,
                      amount: -v.maritalQuotientTransfer,
                  },
              ]
            : []),
        ...(v.maritalQuotientBenefit > 0
            ? [
                  {
                      label: "Marital quotient tax saving",
                      amount: -v.maritalQuotientBenefit,
                  },
              ]
            : []),
        ...(v.personalExemptionBenefit > 0
            ? [
                  {
                      label: "Personal exemption benefit",
                      amount: -v.personalExemptionBenefit,
                  },
              ]
            : []),
        ...(v.ownHomeCredit > 0
            ? [{ label: "Own-home credit", amount: -v.ownHomeCredit }]
            : []),
        ...(v.serviceVoucherCredit > 0
            ? [
                  {
                      label: "Service-voucher credit (dienstencheques)",
                      amount: -v.serviceVoucherCredit,
                  },
              ]
            : []),
        ...(v.federalTaxCredits > 0
            ? [
                  {
                      label: "Tax Credits (reductions)",
                      amount: -v.federalTaxCredits,
                  },
              ]
            : []),
        // Position total, not a deduction step: gross PIT before the exemption
        // benefit and credits listed above. (Was mislabeled "before credits".)
        {
            label: "Federal PIT (before exemption)",
            amount: -v.federalPITBeforeExemption,
        },
        {
            label: "Federal PIT (after credits)",
            amount: -v.federalPITAfterReductions,
        },
        {
            label: `Communal Surcharge (${v.communalSurchargePercent}%)`,
            amount: -v.communalSurcharge,
            rate: v.communalSurchargePercent,
        },
        ...(v.specialSocialSecurityContribution > 0
            ? [
                  {
                      label: "Special Social Security Contribution",
                      amount: -v.specialSocialSecurityContribution,
                  },
              ]
            : []),
        // Property tax is informational for PIT but part of totalTaxBurden, so it
        // must appear as a row — without it the visible rows missed Net Take-Home
        // by exactly this amount.
        ...(v.propertyTaxEstimate > 0
            ? [
                  {
                      label: "Property Tax (estimate)",
                      amount: -v.propertyTaxEstimate,
                  },
              ]
            : []),
        { label: "Net Take-Home", amount: v.netTakeHome },
    ];
}
