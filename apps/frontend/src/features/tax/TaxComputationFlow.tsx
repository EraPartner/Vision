/**
 * TaxComputationFlow
 *
 * The budget-tax overview's computation, composed the way the Belgian
 * assessment notice (aanslagbiljet) composes it: one column read top to bottom,
 * gross → deductions → taxable income → income tax → municipal surcharge →
 * burden → net. It replaces the parallel, same-weight KPI tiles that used to
 * sit here ("summaryCards" widget); a chain of derivations was being drawn as
 * a grid of unrelated facts.
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
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyFormatter,
    useCurrencyPartsFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";
import { KeyValueRows } from "./KeyValueRows";

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
    /** Colour role for the figure — carried over from the tiles this replaces. */
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
    return (
        !group.heading &&
        group.items.length === 1 &&
        group.items[0].value === undefined
    );
}

const FIGURE_TYPE: Record<0 | 1 | 2, string> = {
    0: "type-title-3",
    1: "type-title-2",
    2: "type-title-1",
};

export function TaxComputationFlow({
    calculation,
    portfolioTaxesForYear,
    totalTaxIncludingPortfolio,
    totalTaxIncludingPropertyEstimate,
    viewedYear,
}: TaxComputationFlowProps) {
    const formatPercent = usePercentFormatter();
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
                    {
                        label: t("tax.pit.row.employeeSS"),
                        value: calculation.employeeSocialSecurity,
                        sign: "−",
                    },
                    {
                        label: t("tax.profile.field.professionalExpenses"),
                        value: calculation.professionalExpenses,
                        sign: "−",
                    },
                    {
                        label: t("tax.profile.section.otherDeductions.title"),
                        value: calculation.otherDeductionsTotal,
                        sign: "−",
                    },
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
                    {
                        label: t("tax.pit.row.communalSurcharge"),
                        value: calculation.communalSurcharge,
                        sign: "+",
                    },
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
                    {
                        label: t("tax.pit.row.employeeSS"),
                        value: calculation.employeeSocialSecurity,
                        sign: "+",
                    },
                    {
                        label: t("tax.pit.row.specialSS"),
                        value: calculation.specialSocialSecurityContribution,
                        sign: "+",
                    },
                    {
                        label: t("tax.pit.row.propertyTaxEstimate"),
                        value: calculation.propertyTaxEstimate,
                        sign: "+",
                    },
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
            tone: calculation.netTakeHome >= 0 ? "text-gain" : "text-loss",
            note: t("tax.card.netTakeHome.desc"),
            weight: 2,
        },
    ];

    const coda = [
        {
            key: "portfolioTaxes",
            label: t("tax.pit.row.portfolioTaxesYear", {
                year: String(viewedYear),
            }),
            value: fmt(portfolioTaxesForYear),
            tone: "text-loss",
        },
        {
            key: "inclPortfolio",
            label: t("tax.pit.row.totalTaxInclPortfolio"),
            value: fmt(totalTaxIncludingPortfolio),
            tone: "text-primary",
        },
        {
            key: "inclProperty",
            label: t("tax.pit.row.totalWithPropertyEstimate"),
            value: fmt(totalTaxIncludingPropertyEstimate),
            tone: "text-primary",
        },
    ];

    return (
        <Card className="overflow-hidden">
            <CardHeader>
                <CardTitle>{t("tax.flow.title")}</CardTitle>
                <CardDescription>
                    {t("tax.flow.description", { year: String(viewedYear) })}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <ol className="relative">
                    {stages.map((stage, index) => {
                        const isLast = index === stages.length - 1;
                        const weight = stage.weight ?? 0;
                        return (
                            <li
                                key={stage.id}
                                className="relative flex gap-4 sm:gap-5"
                            >
                                {/* Gutter: the document's spine. The rail runs from this
                                    stage's node down into the next one; the last stage
                                    ends it. */}
                                <div className="relative flex w-4 shrink-0 justify-center">
                                    {!isLast && (
                                        <span
                                            aria-hidden="true"
                                            className="absolute bottom-0 top-3 w-px bg-border"
                                        />
                                    )}
                                    <span
                                        aria-hidden="true"
                                        className={cn(
                                            "absolute top-1.5 h-3 w-3 rounded-full border bg-background",
                                            weight === 0
                                                ? "border-border"
                                                : "border-primary/60 shadow-[0_0_0_3px_hsl(var(--primary)/0.10)]",
                                        )}
                                    />
                                </div>

                                <div
                                    className={cn(
                                        "min-w-0 flex-1",
                                        isLast ? "pb-1" : "pb-5",
                                    )}
                                >
                                    {/* Anchor: a running total in the computation. */}
                                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                                        <p
                                            className={cn(
                                                weight === 2
                                                    ? "type-headline"
                                                    : "type-body font-medium",
                                                "text-foreground",
                                            )}
                                        >
                                            {stage.label}
                                        </p>
                                        <p
                                            className={cn(
                                                "tabular-nums",
                                                FIGURE_TYPE[weight],
                                                stage.tone,
                                            )}
                                        >
                                            <RollingNumber
                                                parts={fmtParts(stage.value)}
                                            />
                                        </p>
                                    </div>
                                    {(stage.note || stage.chip) && (
                                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                                            {stage.note && (
                                                <span className="type-footnote text-label-secondary">
                                                    {stage.note}
                                                </span>
                                            )}
                                            {stage.chip && (
                                                <Badge
                                                    variant="muted"
                                                    size="sm"
                                                    className="tabular-nums"
                                                >
                                                    {stage.chip}
                                                </Badge>
                                            )}
                                        </div>
                                    )}

                                    {/* Operations carrying this anchor into the next one.
                                        A step that is prose rather than a signed
                                        amount stays unboxed — it is the document's
                                        connective tissue, not a line item. */}
                                    {stage.then && isProse(stage.then) ? (
                                        <p className="mt-2.5 type-footnote italic leading-relaxed text-label-secondary">
                                            {stage.then.items[0].label}
                                        </p>
                                    ) : stage.then ? (
                                        <div className="mt-3 rounded-card corner-continuous bg-foreground/[0.04] px-3 py-2">
                                            {stage.then.heading && (
                                                <p className="mb-1.5 type-caption text-label-tertiary">
                                                    {stage.then.heading}
                                                </p>
                                            )}
                                            <ul className="space-y-1">
                                                {stage.then.items.map((op) => (
                                                    <li
                                                        key={op.label}
                                                        className="flex items-baseline justify-between gap-4 type-footnote"
                                                    >
                                                        <span className="text-label-secondary">
                                                            {op.label}
                                                        </span>
                                                        {op.value !==
                                                            undefined && (
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
                    <p className="type-caption text-label-tertiary">
                        {t("tax.flow.coda.title")}
                    </p>
                    <KeyValueRows rows={coda} className="mt-1" />
                </div>
            </CardContent>
        </Card>
    );
}
