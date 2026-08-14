/**
 * TaxComputationFlow
 *
 * The budget-tax overview's computation, composed the way the Belgian
 * assessment notice (aanslagbiljet) composes it: one column read top to bottom,
 * gross → deductions → taxable income → PIT → municipal surcharge → burden →
 * net. It replaces the parallel, same-weight KPI tiles that used to sit here
 * ("summaryCards" widget); a chain of derivations was being drawn as a grid of
 * unrelated facts.
 *
 * Every figure is a pass-through read of `BelgianTaxCalculation` — nothing is
 * computed, rounded or re-derived in this component. The signed operation rows
 * only ever restate relations the calculator itself holds exactly:
 *   taxableIncome = grossIncome − employeeSS − professionalExpenses − otherDeductions
 *   totalPIT      = federalPITAfterReductions + communalSurcharge
 *   totalTaxBurden= totalPIT + employeeSS + specialSS + propertyTaxEstimate
 *   netTakeHome   = grossIncome − totalTaxBurden
 * The bracket/exemption step is deliberately prose, not a signed row: it is not
 * a plain subtraction (regional autonomy factor), and `PitBreakdownCard` below
 * itemises it.
 */
import type { ReactNode } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter, useCurrencyPartsFormatter } from "@/hooks/useCurrencyFormatter";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { formatPercent } from "@/utils/currency";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";

interface FlowOperation {
    label: string;
    /** Omitted for a prose transition (a step that is not a plain +/− amount). */
    value?: number;
    sign?: "+" | "−";
}

interface FlowOperationGroup {
    heading?: string;
    items: FlowOperation[];
}

interface FlowStage {
    id: string;
    label: string;
    value: number;
    /** Tailwind colour class for the figure — carried over from the tiles this replaces. */
    tone: string;
    note?: string;
    chip?: ReactNode;
    /** Emphasis rank: 0 = step, 1 = subtotal, 2 = the document's conclusion. */
    weight?: 0 | 1 | 2;
    /** Operations applied to THIS anchor to reach the next one. */
    then?: FlowOperationGroup;
}

interface TaxComputationFlowProps {
    calculation: BelgianTaxCalculation;
    portfolioTaxesForYear: number;
    totalTaxIncludingPortfolio: number;
    totalTaxIncludingPropertyEstimate: number;
    viewedYear: number;
}

/** A step written as prose (no amount) rather than a signed line item. */
function isProse(group: FlowOperationGroup): boolean {
    return !group.heading && group.items.length === 1 && group.items[0].value === undefined;
}

const FIGURE_SIZE: Record<0 | 1 | 2, string> = {
    0: "text-xl sm:text-2xl",
    1: "text-2xl sm:text-3xl",
    2: "text-3xl sm:text-4xl",
};

export function TaxComputationFlow({
    calculation,
    portfolioTaxesForYear,
    totalTaxIncludingPortfolio,
    totalTaxIncludingPropertyEstimate,
    viewedYear,
}: TaxComputationFlowProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    // Parts formatter keeps the Money micro-typography inside the odometer,
    // exactly as the stat tiles this flow replaces did.
    const fmtParts = useCurrencyPartsFormatter();

    const stages: FlowStage[] = [
        {
            id: "gross",
            label: t("tax.card.profileGrossIncome"),
            value: calculation.grossIncome,
            tone: "text-gain",
            note: t("tax.card.profileGrossIncome.desc"),
            weight: 1,
            then: {
                heading: t("tax.flow.opGroup.deductions"),
                items: [
                    { label: t("tax.pit.row.employeeSS"), value: calculation.employeeSocialSecurity, sign: "−" },
                    { label: t("tax.profile.field.professionalExpenses"), value: calculation.professionalExpenses, sign: "−" },
                    { label: t("tax.profile.section.otherDeductions.title"), value: calculation.otherDeductionsTotal, sign: "−" },
                ],
            },
        },
        {
            id: "taxable",
            label: t("tax.pit.row.taxableIncome"),
            value: calculation.taxableIncome,
            tone: "text-foreground",
            then: { items: [{ label: t("tax.flow.op.brackets") }] },
        },
        {
            id: "federal",
            label: t("tax.pit.row.federalAfter"),
            value: calculation.federalPITAfterReductions,
            tone: "text-loss",
            then: {
                items: [
                    { label: t("tax.pit.row.communalSurcharge"), value: calculation.communalSurcharge, sign: "+" },
                ],
            },
        },
        {
            id: "totalPit",
            label: t("tax.pit.row.totalPIT"),
            value: calculation.totalPIT,
            tone: "text-loss",
            weight: 1,
            chip: `${t("tax.card.monthlyTaxReserve")} · ${fmt(calculation.monthlyTaxReserve)}`,
            then: {
                heading: t("tax.flow.opGroup.alsoOwed"),
                items: [
                    { label: t("tax.pit.row.employeeSS"), value: calculation.employeeSocialSecurity, sign: "+" },
                    { label: t("tax.pit.row.specialSS"), value: calculation.specialSocialSecurityContribution, sign: "+" },
                    { label: t("tax.pit.row.propertyTaxEstimate"), value: calculation.propertyTaxEstimate, sign: "+" },
                ],
            },
        },
        {
            id: "burden",
            label: t("tax.pit.row.totalBurden"),
            value: calculation.totalTaxBurden,
            tone: "text-loss",
            weight: 1,
            chip: `${t("tax.masthead.meta.effectiveBurden")} · ${formatPercent(calculation.effectiveRate, { digits: 1 })}`,
            then: { items: [{ label: t("tax.flow.op.netOut") }] },
        },
        {
            id: "net",
            label: t("tax.card.netTakeHome"),
            value: calculation.netTakeHome,
            tone: calculation.netTakeHome >= 0 ? "amount-gain" : "amount-loss",
            note: t("tax.card.netTakeHome.desc"),
            weight: 2,
        },
    ];

    const coda = [
        {
            label: t("tax.pit.row.portfolioTaxesYear", { year: String(viewedYear) }),
            value: portfolioTaxesForYear,
            tone: "text-loss",
        },
        {
            label: t("tax.pit.row.totalTaxInclPortfolio"),
            value: totalTaxIncludingPortfolio,
            tone: "text-primary",
        },
        {
            label: t("tax.pit.row.totalWithPropertyEstimate"),
            value: totalTaxIncludingPropertyEstimate,
            tone: "text-primary",
        },
    ];

    // The card keeps the default `glass-regular` material: ADR-105 reserves
    // `glass-elevated` for the page's hero, which here is the masthead. This
    // card's prominence comes from its type scale, not from its shadow.
    return (
        <Card className="overflow-hidden">
            <CardHeader>
                <CardTitle>{t("tax.flow.title")}</CardTitle>
                <CardDescription>{t("tax.flow.description", { year: String(viewedYear) })}</CardDescription>
            </CardHeader>
            <CardContent>
                <ol className="relative">
                    {stages.map((stage, index) => {
                        const isLast = index === stages.length - 1;
                        const weight = stage.weight ?? 0;
                        return (
                            <li key={stage.id} className="relative flex gap-4 sm:gap-5">
                                {/* Gutter: the document's spine. The rail runs from this
                                    stage's node down into the next one; the last stage
                                    ends it. */}
                                <div className="relative flex w-4 shrink-0 justify-center">
                                    {!isLast && (
                                        <span
                                            aria-hidden
                                            className="absolute top-3 bottom-0 w-px bg-gradient-to-b from-primary/35 via-border to-border"
                                        />
                                    )}
                                    <span
                                        aria-hidden
                                        className={cn(
                                            "absolute top-1.5 h-3 w-3 rounded-full border bg-background",
                                            weight === 0
                                                ? "border-border"
                                                : "border-primary/60 shadow-[0_0_0_3px_hsl(var(--primary)/0.10)]",
                                        )}
                                    />
                                </div>

                                <div className={cn("min-w-0 flex-1", isLast ? "pb-1" : "pb-5")}>
                                    {/* Anchor: a running total in the computation. */}
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                        <p
                                            className={cn(
                                                "font-semibold text-foreground",
                                                weight === 2 ? "text-base" : "text-sm",
                                            )}
                                        >
                                            {stage.label}
                                        </p>
                                        <p
                                            className={cn(
                                                "font-display font-semibold leading-none tracking-tight tabular-nums",
                                                FIGURE_SIZE[weight],
                                                stage.tone,
                                            )}
                                        >
                                            <RollingNumber parts={fmtParts(stage.value)} />
                                        </p>
                                    </div>
                                    {(stage.note || stage.chip) && (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                                            {stage.note && (
                                                <span className="text-xs text-muted-foreground">{stage.note}</span>
                                            )}
                                            {stage.chip && (
                                                <span className="inline-flex items-center rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5 text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
                                                    {stage.chip}
                                                </span>
                                            )}
                                        </div>
                                    )}

                                    {/* Operations carrying this anchor into the next one.
                                        A step that is prose rather than a signed
                                        amount stays unboxed — it is the document's
                                        connective tissue, not a line item. */}
                                    {stage.then && isProse(stage.then) ? (
                                        <p className="mt-2.5 text-xs italic leading-relaxed text-muted-foreground">
                                            {stage.then.items[0].label}
                                        </p>
                                    ) : stage.then ? (
                                        <div className="mt-3 rounded-[0.5rem] border border-border/50 bg-muted/25 px-3 py-2">
                                            {stage.then.heading && (
                                                <p className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                                    {stage.then.heading}
                                                </p>
                                            )}
                                            <ul className="space-y-1">
                                                {stage.then.items.map((op) => (
                                                    <li
                                                        key={op.label}
                                                        className="flex items-baseline justify-between gap-4 text-xs"
                                                    >
                                                        <span className="text-muted-foreground">{op.label}</span>
                                                        {op.value !== undefined && (
                                                            <span className="shrink-0 font-medium tabular-nums text-foreground">
                                                                {op.sign}
                                                                {fmt(op.value)}
                                                            </span>
                                                        )}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    ) : null}
                                </div>
                            </li>
                        );
                    })}
                </ol>

                {/* Coda: figures that sit outside the personal-income-tax chain. */}
                <div className="mt-5 border-t border-border/60 pt-4">
                    <p className="text-[0.625rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                        {t("tax.flow.coda.title")}
                    </p>
                    <ul className="mt-2 space-y-1.5">
                        {coda.map((row) => (
                            <li key={row.label} className="flex items-baseline justify-between gap-4 text-sm">
                                <span className="text-muted-foreground">{row.label}</span>
                                <span className={cn("shrink-0 font-semibold tabular-nums", row.tone)}>
                                    {fmt(row.value)}
                                </span>
                            </li>
                        ))}
                    </ul>
                </div>
            </CardContent>
        </Card>
    );
}
