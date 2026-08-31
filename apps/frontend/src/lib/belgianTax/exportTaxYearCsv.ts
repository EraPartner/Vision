import type { BelgianTaxProfile, BelgianTaxCalculation } from "./types";
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
    return lines.join("\n");
}

export function exportTaxYearCsv(opts: ExportTaxYearCsvOptions): void {
    const csv = buildTaxYearCsv(opts);
    const filename = `vision-tax-${opts.year}${opts.isFiled ? "-filed" : ""}.csv`;
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    downloadBlob(blob, filename);
}
