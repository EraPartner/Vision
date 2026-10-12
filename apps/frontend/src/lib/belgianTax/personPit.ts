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
import type {
    BelgianTaxYearTable,
    ExemptionBracket,
    PensionReductionParams,
} from "./constants";

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
 * Gifts that qualify for the art. 145/33 reduction: the entered amount when the eligibility flag
 * is set and the gifts reach the minimum ("ten minste 40 euro"), else 0.
 */
export function qualifyingDonations(
    inputs: Pick<ReductionInputs, "charitableDonations" | "charitableDonationsEligible">,
    table: BelgianTaxYearTable,
): number {
    const amount = Math.max(inputs.charitableDonations || 0, 0);
    return inputs.charitableDonationsEligible && amount >= table.charitableDonationMin ? amount : 0;
}

/**
 * Art. 145/33 §1 al. 3-4: rate × the gifts, the gifts limited to 10% of the "totale netto-inkomen"
 * (without separately taxed income; before the deductible spending of arts 104-116) and to the
 * absolute cap. `netIncome` is that total net income of the assessment.
 */
export function computeDonationReduction(
    gifts: number,
    netIncome: number,
    table: BelgianTaxYearTable,
): number {
    const eligible = Math.min(
        Math.max(gifts, 0),
        Math.max(netIncome * 0.1, 0),
        table.charitableDonationAbsoluteCap,
    );
    return eligible * table.charitableDonationRate;
}

/**
 * Federal tax reductions (réductions d'impôt) and the regional service-voucher reduction of one
 * taxpayer. `donationBaseIncome` is the total net income the 10% donation ceiling refers to
 * (art. 145/33 §1 al. 4: "10 % van het totale netto-inkomen"), before the deductible spending
 * (alimony) of arts 104-116.
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

    const donations = computeDonationReduction(
        qualifyingDonations(inputs, table),
        donationBaseIncome,
        table,
    );

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

/** Figures of one taxpayer for the reduction for pensions (WIB 92 arts 147-153). */
export interface PensionReductionInput {
    /** Net pensions (art. 146, 1°: the art. 34 income) of the taxpayer. */
    pensionIncome: number;
    /**
     * Total net income of the taxpayer, before the deductible spending of arts 104-116 (FPS
     * commentary Com.IB 146/15): the denominator of the art. 147 al. 1, 2° proportion and of the
     * art. 153 tax share.
     */
    netIncome: number;
    /** Taxable income (art. 130 base) that arts 151/1, 151/2 and 152 compare with their limits. */
    taxableIncome: number;
    /** Tax after the tax-free sum ("om te slane belasting", Com.IB 146/20). */
    taxAfterExemption: number;
    /**
     * Activity income left out of the denominator of the art. 147 al. 1, 2° proportion (art. 147
     * al. 1, 2°, b-c and al. 3; under a joint assessment also FPS circular AAFisc 40/2011
     * no. 19). Not removed from the art. 153 limit, which keeps the total net income (AAFisc
     * 40/2011, worked example: tax × pensions / 22,014.47 next to 1,861.42 × pensions /
     * (22,014.47 − 3,131.12)). Undefined or 0: the plain total net income.
     */
    excludedActivityIncome?: number;
}

export interface PensionReductionResult {
    /** Art. 147 al. 1, 1°-2° base reduction after art. 152 / art. 151/2. */
    base: number;
    /** Art. 147 al. 1, 1°-2° additional reduction after art. 151/1. */
    additional: number;
    /** Art. 153: the part of the tax on the pensions (tax × pensions / total net income). */
    taxShareLimit: number;
    /** min(base + additional, taxShareLimit). */
    total: number;
}

export const NO_PENSION_REDUCTION: PensionReductionResult = {
    base: 0,
    additional: 0,
    taxShareLimit: 0,
    total: 0,
};

/**
 * Share of the art. 147 base reduction granted at taxable income `t`: art. 152 (to AY 2026: in
 * full up to the lower limit, one third from the upper limit, linear in between) or, from
 * AY 2027, art. 151/2 (the same taper to one third, then from `baseZeroLimits.from` a taper to
 * nothing above `baseZeroLimits.to`).
 */
export function pensionBaseReductionFactor(t: number, p: PensionReductionParams): number {
    const { lower, upper } = p.baseLimits;
    if (p.baseZeroLimits && t > p.baseZeroLimits.from) {
        const { from, to } = p.baseZeroLimits;
        return t > to ? 0 : (to - t) / (to - from) / 3;
    }
    if (t >= upper) return 1 / 3;
    if (t > lower) return 1 / 3 + ((2 / 3) * (upper - t)) / (upper - lower);
    return 1;
}

/** Share of the art. 147 additional reduction granted at taxable income `t` (art. 151/1). */
export function pensionAdditionalReductionFactor(t: number, p: PensionReductionParams): number {
    const { lower, upper } = p.additionalLimits;
    if (t >= upper) return 0;
    if (t > lower) return (upper - t) / (upper - lower);
    return 1;
}

/**
 * Part of a taxpayer's activity income left out of the denominator of the art. 147 al. 1, 2°
 * proportion (WIB 92 art. 147 al. 1, 2°, b-c and al. 3; FPS circular AAFisc 40/2011 nos 17-22):
 *  - 1 with a survivor's pension or transition allowance (b, second case; AAFisc 40/2011 no. 18:
 *    of several applicable denominators the lowest wins);
 *  - 1 with a statutory pension received from the legal pension age of at most `lower` (b);
 *  - (upper − pension) / (upper − lower) above `lower` up to `upper` (c and al. 3);
 *  - 0 otherwise.
 * `grossStatutoryPension` is the gross amount as declared, before any deduction (AAFisc 40/2011
 * no. 22).
 */
export function pensionActivityExclusionFraction(
    grossStatutoryPension: number,
    hasSurvivorPension: boolean,
    p: Pick<PensionReductionParams, "statutoryPensionLimits">,
): number {
    if (hasSurvivorPension) return 1;
    const { lower, upper } = p.statutoryPensionLimits;
    if (grossStatutoryPension <= 0 || grossStatutoryPension > upper) return 0;
    if (grossStatutoryPension <= lower) return 1;
    return (upper - grossStatutoryPension) / (upper - lower);
}

/**
 * Reduction for pensions of one taxpayer (WIB 92 art. 147 al. 1, 1°-2°; arts 151/1, 151/2, 152,
 * 153; computed per spouse under a joint assessment, art. 150):
 *  - base and additional amounts in full when the net income consists only of pensions, else
 *    in proportion to net pensions / total net income;
 *  - the additional amount tapers to nothing between the art. 151/1 limits of the taxable
 *    income; the base amount to one third between the art. 152 limits (from AY 2027 art. 151/2,
 *    which also tapers the last third to nothing);
 *  - art. 153: never more than the part of the tax after the tax-free sum that relates to the
 *    pensions, in proportion to the net income (Com.IB 146/20 and the example of 146/24).
 * The proportion leaves `excludedActivityIncome` out of its denominator (art. 147 al. 1, 2°, b-c;
 * see `pensionActivityExclusionFraction`) and is capped at 1; the art. 153 limit keeps the total
 * net income.
 */
export function computePensionReduction(
    input: PensionReductionInput,
    table: BelgianTaxYearTable,
): PensionReductionResult {
    const pension = Math.max(input.pensionIncome, 0);
    const netIncome = Math.max(input.netIncome, 0);
    if (pension <= 0 || netIncome <= 0) return NO_PENSION_REDUCTION;
    const p = table.pensionReduction;
    const excluded = Math.min(Math.max(input.excludedActivityIncome ?? 0, 0), netIncome);
    const denominator = netIncome - excluded;
    const share = denominator > 0 ? Math.min(pension / denominator, 1) : 1;
    const taxable = Math.max(input.taxableIncome, 0);
    const base = p.base * share * pensionBaseReductionFactor(taxable, p);
    const additional = p.additional * share * pensionAdditionalReductionFactor(taxable, p);
    const taxShareLimit =
        Math.max(input.taxAfterExemption, 0) * Math.min(pension / netIncome, 1);
    return { base, additional, taxShareLimit, total: Math.min(base + additional, taxShareLimit) };
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
 *
 * The regime is that of the taxpayer's region (`inputs.region`): the special finance law of
 * 16 January 1989 art. 5/1 §2 localises the personal income tax "op de plaats waar de
 * belastingplichtige zijn fiscale woonplaats heeft gevestigd op 1 januari van het aanslagjaar",
 * and art. 5/5 §4 makes the regions exclusively competent for the own-home reductions without
 * reference to where the home lies. The deprecated `mortgageRegion` is ignored.
 */
export function resolveMortgageRegime(
    inputs: Omit<OwnHomeCreditInputs, "mortgageRegion">,
): MortgageCreditRegime {
    if (!inputs.mortgageIsPrimaryResidence) return "none";
    if (!inputs.mortgageInterestPaid && !inputs.mortgageCapitalRepaid)
        return "none";
    const region = inputs.region;
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
    const payments = mortgagePayments(inputs);
    if (regime === "flemish_woonbonus") {
        const basket = woonbonusBasket(inputs, table, taxpayer);
        return Math.min(payments, basket.cap) * basket.rate;
    }
    if (regime === "walloon_cheque_habitat") {
        const parts = chequeHabitatParts(inputs, table, taxpayer);
        if (!parts) return 0;
        return Math.min((parts.base + parts.childSupplement) * parts.factor, payments);
    }
    return 0;
}

/** Interest plus capital paid on the loan in the period (each clamped at 0). */
export function mortgagePayments(
    inputs: Pick<OwnHomeCreditInputs, "mortgageInterestPaid" | "mortgageCapitalRepaid">,
): number {
    return (
        Math.max(inputs.mortgageInterestPaid || 0, 0) +
        Math.max(inputs.mortgageCapitalRepaid || 0, 0)
    );
}

/** Woonbonus of one taxpayer: the expense cap of the period ("per belastingplichtige") and rate. */
export interface WoonbonusBasket {
    cap: number;
    rate: number;
}

/** Flemish woonbonus cap and rate of one taxpayer (arts 145/37 §§2-3, 145/38/2 §§2-3). */
export function woonbonusBasket(
    inputs: OwnHomeCreditInputs,
    table: BelgianTaxYearTable,
    taxpayer: OwnHomeCreditTaxpayer,
): WoonbonusBasket {
    const startYear = inputs.mortgageStartYear ?? 0;
    // Taxable periods since the loan year: 0 is the first period, 10 the eleventh.
    const loanAge = Math.max(0, taxpayer.incomeYear - startYear);
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
    return { cap, rate };
}

/**
 * Chèque habitat of one taxpayer before the payments cap of art. 145/46ter §4: the income-based
 * amount (`base`, never negative), the €125 per dependent child (`childSupplement`) and the
 * halving `factor` (0.5 from the eleventh period). Undefined when nothing is due: income above
 * the upper limit, before the first qualifying year or from the twenty-first period.
 */
export interface ChequeHabitatParts {
    base: number;
    childSupplement: number;
    factor: number;
}

export function chequeHabitatParts(
    inputs: OwnHomeCreditInputs,
    table: BelgianTaxYearTable,
    taxpayer: OwnHomeCreditTaxpayer,
): ChequeHabitatParts | undefined {
    const income = Math.max(taxpayer.taxableIncome, 0);
    const { lower, upper } = table.walloonChequeHabitatIncomeThresholds;
    if (income > upper) return undefined;
    const base =
        income <= lower
            ? table.walloonChequeHabitatBase
            : table.walloonChequeHabitatBase -
              (income - lower) * table.walloonChequeHabitatPhaseOutRate;
    const children = Math.max(inputs.dependentChildren || 0, 0);
    const disabled = Math.min(Math.max(inputs.dependentChildrenDisabled || 0, 0), children);
    const childSupplement = (children + disabled) * table.walloonChequeHabitatChildSupplement;
    // Periods since the first claimed one: 0 is the first, 10 the eleventh, 20 the 21st.
    // Before the first qualifying year the conditions are not met yet.
    const startYear = inputs.mortgageStartYear ?? 0;
    const loanAge = Math.max(0, taxpayer.incomeYear - startYear);
    const first = inputs.firstQualifyingYear;
    if (first !== undefined && taxpayer.incomeYear < first) return undefined;
    const period = first !== undefined ? taxpayer.incomeYear - first : loanAge;
    if (period >= 20) return undefined;
    return { base: Math.max(base, 0), childSupplement, factor: period >= 10 ? 0.5 : 1 };
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
    /** Reduction for pensions (arts 147-153); adds a row when > 0. */
    pensionReduction: number;
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
        ...(v.pensionReduction > 0
            ? [{ label: "Pension reduction (arts 147-153)", amount: -v.pensionReduction }]
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
