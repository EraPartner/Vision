/**
 * Per-person Belgian PIT building blocks shared by the single-profile engine (`pit.ts`) and the
 * household engine (`household.ts`). Every function here works on one taxpayer's figures; the
 * household engine calls them once per partner. Rule sources are listed in
 * docs/reference/belgian-tax-rule-matrix.md.
 */

import type {
    BelgianRegion,
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
    | "serviceVoucherEligible"
    | "medicalExpenses"
>;

/**
 * Regional service-voucher (dienstencheques / titres-services) tax reduction.
 *
 * Three different scheme shapes:
 *  - Brussels: 15% of voucher cost on the first 172 vouchers.
 *  - Wallonia: fixed €0.90 per voucher on the first 150 vouchers.
 *  - Flanders: abolished from 1 Jan 2025 (rate/amount = 0).
 *
 * Returns 0 when the eligibility flag is false or count is 0.
 */
export function computeServiceVoucherCredit(
    inputs: Pick<ReductionInputs, "serviceVoucherCount" | "serviceVoucherEligible">,
    region: BelgianRegion,
    table: BelgianTaxYearTable,
): number {
    if (!inputs.serviceVoucherEligible) return 0;
    const count = Math.max(inputs.serviceVoucherCount || 0, 0);
    if (count <= 0) return 0;
    const params = table.serviceVoucherRegional[region];
    if (!params) return 0;
    const eligibleCount = Math.min(count, params.maxCount);
    if (eligibleCount <= 0) return 0;
    if (params.amountPerVoucher > 0) {
        return eligibleCount * params.amountPerVoucher;
    }
    if (params.rate > 0) {
        return eligibleCount * params.voucherPrice * params.rate;
    }
    return 0;
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
>;

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
    if (region === "wallonia" && startYear >= 2016)
        return "walloon_cheque_habitat";
    return "none";
}

/**
 * Compute the regional own-home tax credit.
 *
 * Flemish woonbonus (pre-2020, primary residence) — two sub-regimes by origination year:
 *   - Pre-2016 ("ordinary" woonbonus): base €2,280 (IY 2025)
 *   - 2016-2019 ("geïntegreerde" woonbonus): base €1,520 (IY 2025; merged housing & ordinary
 *     credits into a single, reduced-cap scheme)
 *   credit = min(interest + capital, base_cap [+ first-10y supplement] [+ 3+ children supplement]) × 40%
 *
 * Walloon chèque habitat (post-2016, primary residence, first 10 loan years):
 *   credit = base [+ €125 × dependent children]
 *   (Simplified — actual scheme has income-based phaseout and decreasing tail in years 11–20.)
 *
 * All other cases (Brussels, post-2020 Flemish, secondary residences): 0.
 */
export function computeOwnHomeCredit(
    inputs: OwnHomeCreditInputs,
    table: BelgianTaxYearTable,
    regime: MortgageCreditRegime,
): number {
    if (regime === "none") return 0;
    const interest = Math.max(inputs.mortgageInterestPaid || 0, 0);
    const capital = Math.max(inputs.mortgageCapitalRepaid || 0, 0);

    if (regime === "flemish_woonbonus") {
        const startYear = inputs.mortgageStartYear ?? 0;
        const loanAge = Math.max(0, table.year - startYear);
        // 2016 reform: loans signed 2016+ use the lower "geïntegreerde" base cap.
        const isIntegrated = startYear >= 2016;
        let cap = isIntegrated
            ? table.flemishIntegratedWoonbonusBaseCap
            : table.flemishWoonbonusBaseCap;
        if (loanAge < 10) cap += table.flemishWoonbonusExtraFirst10y;
        if ((inputs.dependentChildren || 0) >= 3)
            cap += table.flemishWoonbonusExtraChildren;
        const eligibleExpenses = Math.min(interest + capital, cap);
        return eligibleExpenses * table.flemishWoonbonusRate;
    }

    if (regime === "walloon_cheque_habitat") {
        const startYear = inputs.mortgageStartYear ?? 0;
        const loanAge = Math.max(0, table.year - startYear);
        // First 10 years only in our simplified model.
        if (loanAge >= 10) return 0;
        const childSupplement =
            Math.max(inputs.dependentChildren || 0, 0) *
            table.walloonChequeHabitatChildSupplement;
        return table.walloonChequeHabitatBase + childSupplement;
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
