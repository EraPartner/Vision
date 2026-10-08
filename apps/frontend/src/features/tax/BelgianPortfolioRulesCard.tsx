import { AlertTriangle } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxYearTable } from "@/lib/belgianTax";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { List } from "@/components/ui/list";
import { cn } from "@/lib/utils";

interface BelgianPortfolioRulesCardProps {
    totalDividendIncome: number;
    grossDividendWht: number;
    dividendWhtReclaim: number | null;
    dividendWhtNetCost: number | null;
    unknownDividendConventionCount: number;
    dividendExemption: number;
    tobRecorded: number;
    tobAutoEstimate: number;
    tacrEstimate: number;
    cgtEstimate: number;
    reyndersEstimate: number;
    taxTable: BelgianTaxYearTable;
}

/** Belgian investment-tax rules + estimates section of the portfolio-tax page ("belgianRules" widget). */
export function BelgianPortfolioRulesCard({
    totalDividendIncome,
    grossDividendWht,
    dividendWhtReclaim,
    dividendWhtNetCost,
    unknownDividendConventionCount,
    dividendExemption,
    tobRecorded,
    tobAutoEstimate,
    tacrEstimate,
    cgtEstimate,
    reyndersEstimate,
    taxTable,
}: BelgianPortfolioRulesCardProps) {
    const formatPercent = usePercentFormatter();
    const { t, tc } = useLanguage();
    const fmt = useCurrencyFormatter();
    const dividendMetrics = [
        {
            key: "income",
            label: t("tax.dividendIncomeTracked"),
            value: totalDividendIncome,
            tone: "text-foreground",
            description: t("tax.fromDividendTransactions"),
        },
        {
            key: "paid",
            label: t("tax.dividendWhtPaid"),
            value: grossDividendWht,
            tone: "text-loss",
            description: t("tax.witheldAtSource"),
        },
        {
            key: "reclaim",
            label: t("tax.dividendWhtReclaim"),
            value: dividendWhtReclaim,
            tone: "text-gain",
            description: `${t("tax.firstExemptBelgianDividends")} (${fmt(dividendExemption)})`,
        },
        {
            key: "net",
            label: t("tax.dividendWhtNetCost"),
            value: dividendWhtNetCost,
            tone: "text-loss",
            description: t("tax.afterReclaim"),
        },
    ];
    const estimates = [
        {
            key: "tob-recorded",
            title: t("tax.tobRecorded"),
            badge: t("tax.transactionTax"),
            description: t("tax.tobTrackedFromBuyTaxes"),
            value: tobRecorded,
            visible: true,
        },
        {
            key: "tob-estimate",
            title: t("tax.tobAutoEstimate"),
            badge: t("tax.estimated"),
            description: t("tax.tobAutoEstimateDesc"),
            value: tobAutoEstimate,
            visible: true,
        },
        {
            key: "tacr",
            title: t("tax.tacrEstimate"),
            badge: formatPercent(taxTable.securitiesAccountTaxRate * 100, {
                digits: 2,
            }),
            description: t("tax.tacrEstimateDesc"),
            value: tacrEstimate,
            visible: tacrEstimate > 0,
        },
        {
            key: "cgt",
            title: t("tax.cgtEstimate"),
            badge: formatPercent(taxTable.capitalGainsTaxRate * 100, {
                digits: 0,
            }),
            description: t("tax.cgtEstimateDesc"),
            value: cgtEstimate,
            visible: cgtEstimate > 0,
        },
        {
            key: "reynders",
            title: t("tax.reyndersEstimate"),
            badge: formatPercent(taxTable.reyndersTaxRate * 100, { digits: 0 }),
            description: t("tax.reyndersEstimateDesc"),
            value: reyndersEstimate,
            visible: reyndersEstimate > 0,
        },
    ].filter((estimate) => estimate.visible);
    const notes = [
        {
            key: "automatic",
            label: t("tax.currentlyAutomaticLabel"),
            text: t("tax.currentlyAutomaticPortfolio"),
        },
        {
            key: "manual",
            label: t("tax.manualAdjustmentsLabel"),
            text: t("tax.manualAdjustmentsDesc"),
        },
        {
            key: "notAutomatic",
            label: t("tax.notAutomaticLabel"),
            text: t("tax.notAutomaticPortfolio"),
        },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.widget.belgianRules")}</CardTitle>
                <CardDescription>{t("tax.belgianRulesDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <dl className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
                    {dividendMetrics.map((metric) => (
                        <div key={metric.key} className="min-w-0">
                            <dt className="type-caption text-label-tertiary">
                                {metric.label}
                            </dt>
                            <dd
                                className={cn(
                                    "mt-1 type-title-3 tabular-nums",
                                    metric.value === null
                                        ? "text-label-tertiary"
                                        : metric.tone,
                                )}
                            >
                                {metric.value === null
                                    ? t("tax.incomplete")
                                    : fmt(metric.value)}
                            </dd>
                            <dd className="type-footnote text-label-secondary">
                                {metric.description}
                            </dd>
                        </div>
                    ))}
                </dl>

                {unknownDividendConventionCount > 0 && (
                    <Alert variant="warning">
                        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
                        <AlertDescription>
                            {tc(
                                "tax.dividendConventionIncomplete",
                                unknownDividendConventionCount,
                            )}
                        </AlertDescription>
                    </Alert>
                )}

                <List>
                    {estimates.map((estimate) => (
                        <li
                            key={estimate.key}
                            className="flex items-start justify-between gap-4 px-4 py-3"
                        >
                            <div className="min-w-0 space-y-0.5">
                                <p className="flex flex-wrap items-center gap-2 type-body font-medium text-foreground">
                                    {estimate.title}
                                    <Badge variant="outline" size="sm">
                                        {estimate.badge}
                                    </Badge>
                                </p>
                                <p className="type-footnote text-label-secondary">
                                    {estimate.description}
                                </p>
                            </div>
                            <span className="shrink-0 type-headline tabular-nums text-loss">
                                {fmt(estimate.value)}
                            </span>
                        </li>
                    ))}
                </List>

                <div className="space-y-2">
                    {notes.map((note) => (
                        <p
                            key={note.key}
                            className="type-callout text-label-secondary"
                        >
                            <span className="type-headline text-foreground">
                                {note.label}
                            </span>{" "}
                            {note.text}
                        </p>
                    ))}
                </div>
            </CardContent>
        </Card>
    );
}
