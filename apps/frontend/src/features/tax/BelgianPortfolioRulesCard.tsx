import { useLanguage } from "@/contexts/LanguageContext";
import {
    useCurrencyFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxYearTable } from "@/lib/belgianTax";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";

interface BelgianPortfolioRulesCardProps {
    totalDividendIncome: number;
    grossDividendWht: number;
    dividendWhtReclaim: number;
    dividendWhtNetCost: number;
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
    dividendExemption,
    tobRecorded,
    tobAutoEstimate,
    tacrEstimate,
    cgtEstimate,
    reyndersEstimate,
    taxTable,
}: BelgianPortfolioRulesCardProps) {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();
    const dividendMetrics = [
        {
            key: "income",
            label: t("tax.dividendIncomeTracked"),
            value: totalDividendIncome,
            valueClassName: "",
            description: t("tax.fromDividendTransactions"),
        },
        {
            key: "paid",
            label: t("tax.dividendWhtPaid"),
            value: grossDividendWht,
            valueClassName: "text-loss",
            description: t("tax.witheldAtSource"),
        },
        {
            key: "reclaim",
            label: t("tax.dividendWhtReclaim"),
            value: dividendWhtReclaim,
            valueClassName: "text-gain",
            description: `${t("tax.firstExemptBelgianDividends")} (${fmt(dividendExemption)})`,
        },
        {
            key: "net",
            label: t("tax.dividendWhtNetCost"),
            value: dividendWhtNetCost,
            valueClassName: "text-loss",
            description: t("tax.afterReclaim"),
        },
    ];
    const estimateCards = [
        {
            key: "tob-recorded",
            title: t("tax.tobRecorded"),
            badge: t("tax.transactionTax"),
            description: t("tax.tobTrackedFromBuyTaxes"),
            value: tobRecorded,
            compact: true,
            visible: true,
        },
        {
            key: "tob-estimate",
            title: t("tax.tobAutoEstimate"),
            badge: t("tax.estimated"),
            description: t("tax.tobAutoEstimateDesc"),
            value: tobAutoEstimate,
            compact: true,
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
            compact: false,
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
            compact: false,
            visible: cgtEstimate > 0,
        },
        {
            key: "reynders",
            title: t("tax.reyndersEstimate"),
            badge: formatPercent(taxTable.reyndersTaxRate * 100, { digits: 0 }),
            description: t("tax.reyndersEstimateDesc"),
            value: reyndersEstimate,
            compact: false,
            visible: reyndersEstimate > 0,
        },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.widget.belgianRules")}</CardTitle>
                <CardDescription>{t("tax.belgianRulesDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    {dividendMetrics.map((metric) => (
                        <div
                            key={metric.key}
                            className="rounded-lg border border-border p-3"
                        >
                            <p className="text-xs text-muted-foreground mb-1">
                                {metric.label}
                            </p>
                            <p
                                className={`text-lg font-bold tabular-nums ${metric.valueClassName}`}
                            >
                                {fmt(metric.value)}
                            </p>
                            <p className="text-xs text-muted-foreground mt-1">
                                {metric.description}
                            </p>
                        </div>
                    ))}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    {estimateCards
                        .filter((card) => card.compact)
                        .map((card) => (
                            <div
                                key={card.key}
                                className="rounded-lg border border-border p-3"
                            >
                                <div className="flex items-center justify-between gap-2 flex-wrap">
                                    <p className="text-sm font-semibold text-foreground">
                                        {card.title}
                                    </p>
                                    <Badge variant="outline">
                                        {card.badge}
                                    </Badge>
                                </div>
                                <p className="text-xs text-muted-foreground mt-1">
                                    {card.description}
                                </p>
                                <p className="text-base font-bold tabular-nums mt-2 text-loss">
                                    {fmt(card.value)}
                                </p>
                            </div>
                        ))}
                </div>

                {estimateCards
                    .filter((card) => !card.compact && card.visible)
                    .map((card) => (
                        <div
                            key={card.key}
                            className="rounded-lg border border-border p-3"
                        >
                            <div className="flex items-center justify-between gap-2 flex-wrap">
                                <p className="text-sm font-semibold text-foreground">
                                    {card.title}
                                </p>
                                <Badge variant="outline">{card.badge}</Badge>
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                                {card.description}
                            </p>
                            <p className="text-base font-bold tabular-nums mt-2 text-loss">
                                {fmt(card.value)}
                            </p>
                        </div>
                    ))}

                <div className="space-y-2 text-xs text-muted-foreground">
                    <p>
                        <span className="font-semibold text-foreground">
                            {t("tax.currentlyAutomaticLabel")}
                        </span>{" "}
                        {t("tax.currentlyAutomaticPortfolio")}
                    </p>
                    <p>
                        <span className="font-semibold text-foreground">
                            {t("tax.manualAdjustmentsLabel")}
                        </span>{" "}
                        {t("tax.manualAdjustmentsDesc")}
                    </p>
                    <p>
                        <span className="font-semibold text-foreground">
                            {t("tax.notAutomaticLabel")}
                        </span>{" "}
                        {t("tax.notAutomaticPortfolio")}
                    </p>
                </div>
            </CardContent>
        </Card>
    );
}
