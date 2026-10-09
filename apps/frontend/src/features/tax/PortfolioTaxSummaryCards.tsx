import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyPartsFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

interface PortfolioTaxSummaryCardsProps {
    totalTaxes: number;
    totalFees: number;
    totalTaxesAndFees: number;
    effectiveTaxRate: number;
    portfolioTaxesPlusPIT: number;
    totalManualTaxes: number;
    totalManualFees: number;
    txYear: number;
}

/**
 * Hero of the portfolio-tax page ("summaryCards" widget): the year's total
 * costs as the one headline figure, with the taxes, fees, effective rate,
 * combined total and manual adjustments it is made of as supporting figures.
 * Every number is a pass-through of the hook's totals.
 */
export function PortfolioTaxSummaryCards({
    totalTaxes,
    totalFees,
    totalTaxesAndFees,
    effectiveTaxRate,
    portfolioTaxesPlusPIT,
    totalManualTaxes,
    totalManualFees,
    txYear,
}: PortfolioTaxSummaryCardsProps) {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    // Parts formatter keeps the Money micro-typography inside the odometer.
    const fmtParts = useCurrencyPartsFormatter();
    const year = String(txYear);

    const figures = [
        {
            key: "taxes",
            label: t("tax.totalTaxesPaid"),
            value: <RollingNumber parts={fmtParts(totalTaxes)} />,
            detail: t("tax.acrossAllInvestmentsYear", { year }),
            tone: "text-loss",
        },
        {
            key: "fees",
            label: t("tax.totalFeesPaid"),
            value: <RollingNumber parts={fmtParts(totalFees)} />,
            detail: t("tax.brokerAndMgmtFeesYear", { year }),
            tone: "text-loss",
        },
        {
            key: "effectiveRate",
            label: t("tax.effectiveTaxRate"),
            value: formatPercent(effectiveTaxRate, { digits: 1 }),
            detail: t("tax.onRealizedGains"),
            tone: effectiveTaxRate > 25 ? "text-loss" : "text-foreground",
        },
        {
            key: "withIncomeTax",
            label: t("tax.totalWithPIT"),
            value: <RollingNumber parts={fmtParts(portfolioTaxesPlusPIT)} />,
            detail: t("tax.totalWithPITDesc"),
            tone: "text-primary",
        },
        {
            key: "manual",
            label: t("tax.manualAdjustments"),
            value: (
                <RollingNumber
                    parts={fmtParts(totalManualTaxes + totalManualFees)}
                />
            ),
            detail: t("tax.manualAdjustmentsDescShort"),
            tone: "text-foreground",
        },
    ];

    return (
        <Card asChild className="overflow-hidden">
            <section aria-labelledby="portfolio-tax-total-costs">
                <CardContent
                    variant="headerless"
                    className="grid gap-6 xl:grid-cols-[minmax(14rem,1fr)_3fr] xl:items-start"
                >
                    <div className="min-w-0">
                        <h3
                            id="portfolio-tax-total-costs"
                            className="type-caption text-label-tertiary"
                        >
                            {t("tax.totalCosts")}
                        </h3>
                        <p className="mt-1 type-large-title tabular-nums text-loss">
                            <RollingNumber parts={fmtParts(totalTaxesAndFees)} />
                        </p>
                        <p className="mt-1 type-footnote text-label-secondary">
                            {t("tax.combinedTaxesAndFeesYear", { year })}
                        </p>
                    </div>
                    <dl className="grid grid-cols-2 gap-x-8 gap-y-6 sm:grid-cols-3">
                        {figures.map((figure) => (
                            <div key={figure.key} className="min-w-0">
                                <dt className="type-caption text-label-tertiary">
                                    {figure.label}
                                </dt>
                                <dd
                                    className={cn(
                                        "mt-1 type-title-3 tabular-nums",
                                        figure.tone,
                                    )}
                                >
                                    {figure.value}
                                </dd>
                                <dd className="type-footnote text-label-secondary">
                                    {figure.detail}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </CardContent>
            </section>
        </Card>
    );
}
