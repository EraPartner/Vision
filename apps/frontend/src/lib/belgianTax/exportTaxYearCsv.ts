import type { BelgianTaxProfile, BelgianTaxCalculation } from "./types";
import type {
    BelgianTaxHouseholdV2,
    HouseholdPartner,
    HouseholdTaxResult,
    PartnerTaxResult,
} from "./householdTypes";
import { downloadBlob } from "@/lib/downloadBlob";
import { escapeCsvValue } from "@/lib/csv";

interface ExportTaxYearCsvOptions {
    year: number;
    profile: BelgianTaxProfile;
    calculation: BelgianTaxCalculation;
    currency: string;
    isFiled: boolean;
    hasFrozenCalculation: boolean;
    generatedAt: string;
    /** The year's household; with its result, adds per-partner sections for two partners. */
    household?: BelgianTaxHouseholdV2 | null | undefined;
    /** The year's household result (the frozen one for a frozen year). */
    householdResult?: HouseholdTaxResult | null | undefined;
}

const PARTNER_COLUMNS = { A: "You", B: "Partner" } as const;

const money = (value: number) =>
    Number.isFinite(value) ? Number(value.toFixed(2)) : 0;

function partnerInputRows(
    partner: HouseholdPartner | undefined,
): Array<[string, number]> {
    const r = partner?.reductions;
    return [
        [
            "Gross activity income",
            (partner?.activities ?? []).reduce(
                (sum, a) =>
                    sum +
                    (a.kind === "net_professional_amount"
                        ? (a.netProfessionalIncome ?? 0)
                        : a.grossIncome),
                0,
            ),
        ],
        ["Income activities", partner?.activities.length ?? 0],
        ["Other taxable income", partner?.otherTaxableIncome ?? 0],
        ["Alimony paid", partner?.alimonyPaid ?? 0],
        ["Union dues", partner?.unionDues ?? 0],
        ["Personal pension contributions", r?.personalPensionContributions ?? 0],
        ["Life insurance premiums", r?.lifeInsurancePremiums ?? 0],
        ["Employee group insurance", r?.employeeGroupInsuranceContributions ?? 0],
        ["Charitable donations", r?.charitableDonations ?? 0],
        ["Childcare costs", r?.childcareCosts ?? 0],
        ["Domestic help costs", r?.domesticHelpCosts ?? 0],
    ];
}

const PARTNER_RESULT_ROWS: Array<[string, (p: PartnerTaxResult) => number]> = [
    ["Gross income", (p) => p.grossIncome],
    ["Employee social security", (p) => p.employeeSocialSecurity],
    ["Professional expenses", (p) => p.professionalExpenses],
    ["Net professional income", (p) => p.netProfessionalIncome],
    ["Marital quotient adjustment", (p) => p.quotientAdjustment],
    ["Taxable income", (p) => p.taxableIncome],
    ["Tax-free sum charged", (p) => p.exemption.applied],
    ["Tax after the tax-free sum", (p) => p.pitAfterExemption],
    ["Pension reduction", (p) => p.pensionReduction],
    ["Tax reductions applied", (p) => p.reductionsApplied],
    ["Communal surcharge", (p) => p.communalSurcharge],
    ["Total PIT", (p) => p.totalPIT],
    ["Special social security contribution", (p) => p.specialSocialSecurityContribution],
];

/**
 * Per-partner sections (ADR-200/201): inputs and results with a column per partner and the
 * household total, then the assessment and the marital quotient. Empty unless two partners are
 * assessed, so a one-partner export keeps exactly its previous lines.
 */
function householdLines(
    household: BelgianTaxHouseholdV2 | null | undefined,
    result: HouseholdTaxResult | null | undefined,
    currency: string,
): string[] {
    if (!household || !result || result.partners.length < 2) return [];
    const ids = result.partners.map((p) => p.partnerId);
    const header = row([
        "Field",
        ...ids.map((id) => PARTNER_COLUMNS[id]),
        "Household",
    ]);
    const lines: string[] = ["", row(["# Per-partner inputs"]), header];
    const inputs = ids.map((id) =>
        partnerInputRows(household.partners.find((p) => p.id === id)),
    );
    inputs[0]?.forEach(([label], index) => {
        const values = inputs.map((rows) => rows[index]?.[1] ?? 0);
        lines.push(
            row([label, ...values.map(money), money(values.reduce((a, b) => a + b, 0))]),
        );
    });
    lines.push("", row(["# Per-partner calculation"]));
    lines.push(
        row([
            "Component",
            ...ids.map((id) => `${PARTNER_COLUMNS[id]} (${currency})`),
            `Household (${currency})`,
        ]),
    );
    for (const [label, pick] of PARTNER_RESULT_ROWS) {
        const values = result.partners.map(pick);
        lines.push(
            row([label, ...values.map(money), money(values.reduce((a, b) => a + b, 0))]),
        );
    }
    const { assessment, quotient } = result;
    lines.push("", row(["# Assessment"]));
    lines.push(row(["Assessment mode", assessment.mode]));
    lines.push(row(["Legal basis", assessment.legalBasis]));
    if (assessment.mode === "joint") {
        lines.push(row(["Marital quotient applied", quotient.applied]));
        if (quotient.applied && quotient.fromPartnerId && quotient.toPartnerId) {
            lines.push(
                row([
                    "Marital quotient transfer",
                    money(quotient.transfer),
                    PARTNER_COLUMNS[quotient.fromPartnerId],
                    PARTNER_COLUMNS[quotient.toPartnerId],
                ]),
            );
            lines.push(row(["Marital quotient benefit", money(quotient.benefit)]));
        }
    }
    return lines;
}

function row(
    cells: ReadonlyArray<string | number | boolean | null | undefined>,
): string {
    return cells.map(escapeCsvValue).join(",");
}

function profileInputRows(
    profile: BelgianTaxProfile,
): Array<[string, string | number | boolean]> {
    return [
        ["Employment type", profile.employmentType],
        ["Gross annual income", profile.grossAnnualIncome],
        ["Other taxable income", profile.otherTaxableIncome],
        ["Professional expense method", profile.professionalExpenseMethod],
        ["Actual professional expenses", profile.actualProfessionalExpenses],
        ["Communal surcharge %", profile.communalSurchargePercent],
        ["Region", profile.region],
        ["Filing status", profile.filingStatus ?? "single"],
        ["Dependent children", profile.dependentChildren],
        ["Dependent children under 3", profile.dependentChildrenUnder3 ?? 0],
        ["Dependent children disabled", profile.dependentChildrenDisabled ?? 0],
        ["Dependent other persons", profile.dependentOtherPersons],
        [
            "Dependent other persons disabled",
            profile.dependentOtherPersonsDisabled ?? 0,
        ],
        ["Taxpayer disabled", profile.isDisabled],
        ["Spouse disabled", profile.isSpouseDisabled],
        ["Isolated parent", profile.isIsolatedParent ?? false],
        ["Spouse professional income", profile.spouseProfessionalIncome ?? 0],
        ["Cadastral income (own home)", profile.cadastralIncome],
        ["Mortgage interest paid", profile.mortgageInterestPaid],
        ["Mortgage capital repaid", profile.mortgageCapitalRepaid ?? 0],
        ["Mortgage start year", profile.mortgageStartYear ?? ""],
        ["Mortgage region", profile.mortgageRegion ?? ""],
        ["Pension scheme", profile.pensionScheme ?? ""],
        [
            "Personal pension contributions",
            profile.personalPensionContributions,
        ],
        ["Life insurance premiums", profile.lifeInsurancePremiums],
        ["Charitable donations", profile.charitableDonations],
        ["Childcare costs", profile.childcareCosts],
        ["Childcare eligible days", profile.childcareEligibleDays ?? 0],
        [
            "Employee group insurance",
            profile.employeeGroupInsuranceContributions ?? 0,
        ],
        ["Union dues", profile.unionDues],
        ["Medical expenses", profile.medicalExpenses],
        ["Domestic help costs", profile.domesticHelpCosts ?? 0],
        ["Service vouchers", profile.serviceVoucherCount ?? 0],
        ["Annual dividend income", profile.annualDividendIncome ?? 0],
        ["Annual savings interest", profile.annualSavingsInterest ?? 0],
        ["Alimony paid", profile.alimonyPaid],
    ];
}

function calculationRows(calc: BelgianTaxCalculation): Array<[string, number]> {
    return [
        ["Gross income", calc.grossIncome],
        ["Employee social security", calc.employeeSocialSecurity],
        [
            "Special social security contribution",
            calc.specialSocialSecurityContribution,
        ],
        ["Professional expenses", calc.professionalExpenses],
        ["Other deductions total", calc.otherDeductionsTotal],
        ["Taxable income", calc.taxableIncome],
        ["Federal PIT bracket 1", calc.federalPITBracket1],
        ["Federal PIT bracket 2", calc.federalPITBracket2],
        ["Federal PIT bracket 3", calc.federalPITBracket3],
        ["Federal PIT bracket 4", calc.federalPITBracket4],
        ["Federal PIT before exemption", calc.federalPITBeforeExemption],
        ["Personal exemption amount", calc.personalExemptionAmount],
        ["Personal exemption benefit", calc.personalExemptionBenefit],
        ["Federal tax credits", calc.federalTaxCredits],
        ["Pension reduction", calc.pensionReduction ?? 0],
        ["Own-home credit", calc.ownHomeCredit],
        ["Total tax reductions applied", calc.taxReductions],
        ["Federal PIT after reductions", calc.federalPITAfterReductions],
        ["Communal surcharge", calc.communalSurcharge],
        ["Total PIT", calc.totalPIT],
        ["Property tax estimate", calc.propertyTaxEstimate],
        ["Dividend WHT reclaim", calc.dividendWhtReclaim],
        ["Savings interest tax", calc.savingsInterestTax],
        ["Marital quotient transfer", calc.maritalQuotientTransfer],
        ["Marital quotient benefit", calc.maritalQuotientBenefit],
        ["Service voucher credit", calc.serviceVoucherCredit],
        ["Total tax burden", calc.totalTaxBurden],
        ["Effective rate %", calc.effectiveRate],
        ["Marginal rate %", calc.marginalRate],
        ["Net take home", calc.netTakeHome],
        ["Monthly tax reserve", calc.monthlyTaxReserve],
    ];
}

export function buildTaxYearCsv(opts: ExportTaxYearCsvOptions): string {
    const {
        year,
        profile,
        calculation,
        currency,
        isFiled,
        hasFrozenCalculation,
        generatedAt,
        household,
        householdResult,
    } = opts;
    const lines: string[] = [];
    lines.push(row(["# Vision tax year export"]));
    lines.push(row(["Income year", year]));
    lines.push(row(["Currency", currency]));
    lines.push(
        row([
            "Status",
            isFiled ? "filed" : hasFrozenCalculation ? "frozen" : "live",
        ]),
    );
    lines.push(row(["Generated at", generatedAt]));
    lines.push("");
    lines.push(row(["# Profile inputs"]));
    lines.push(row(["Field", "Value"]));
    for (const [key, value] of profileInputRows(profile))
        lines.push(row([key, value]));
    lines.push("");
    lines.push(row(["# Calculation"]));
    lines.push(row(["Component", `Amount (${currency})`]));
    for (const [key, value] of calculationRows(calculation)) {
        lines.push(
            row([key, Number.isFinite(value) ? Number(value.toFixed(2)) : 0]),
        );
    }
    lines.push(...householdLines(household, householdResult, currency));
    return lines.join("\n");
}

export function exportTaxYearCsv(opts: ExportTaxYearCsvOptions): void {
    const csv = buildTaxYearCsv(opts);
    const filename = `vision-tax-${opts.year}${opts.isFiled ? "-filed" : ""}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, filename);
}
