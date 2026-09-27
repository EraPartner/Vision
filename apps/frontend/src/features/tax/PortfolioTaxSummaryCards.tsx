import {
    Landmark,
    Receipt,
    TrendingDown,
    AlertTriangle,
    SlidersHorizontal,
} from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import {
    useCurrencyPartsFormatter,
    usePercentFormatter,
} from "@/hooks/useCurrencyFormatter";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { TaxSummaryCard } from "@/pages/portfolio/tax/TaxSummaryCard";

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

/** Summary stat cards of the portfolio-tax page ("summaryCards" widget). */
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
    // Parts formatter: same currency/locale/decimals resolution as the string
    // formatter it replaced, but the tiles keep the Money micro-typography.
    const fmtParts = useCurrencyPartsFormatter();

    const cards = [
        {
            title: t("tax.totalTaxesPaid"),
            value: <RollingNumber parts={fmtParts(totalTaxes)} />,
            icon: Landmark,
            desc: t("tax.acrossAllInvestmentsYear", { year: String(txYear) }),
            cls: "text-loss",
        },
        {
            title: t("tax.totalFeesPaid"),
            value: <RollingNumber parts={fmtParts(totalFees)} />,
            icon: Receipt,
            desc: t("tax.brokerAndMgmtFeesYear", { year: String(txYear) }),
            cls: "text-loss",
        },
        {
            title: t("tax.totalCosts"),
            value: <RollingNumber parts={fmtParts(totalTaxesAndFees)} />,
            icon: TrendingDown,
            desc: t("tax.combinedTaxesAndFeesYear", { year: String(txYear) }),
            cls: "text-loss",
        },
        {
            title: t("tax.effectiveTaxRate"),
            value: formatPercent(effectiveTaxRate, { digits: 1 }),
            icon: AlertTriangle,
            desc: t("tax.onRealizedGains"),
            cls: effectiveTaxRate > 25 ? "text-loss" : "text-muted-foreground",
        },
        {
            title: t("tax.totalWithPIT"),
            value: <RollingNumber parts={fmtParts(portfolioTaxesPlusPIT)} />,
            icon: Landmark,
            desc: t("tax.totalWithPITDesc"),
            cls: "text-primary",
        },
        {
            title: t("tax.manualAdjustments"),
            value: (
                <RollingNumber
                    parts={fmtParts(totalManualTaxes + totalManualFees)}
                />
            ),
            icon: SlidersHorizontal,
            desc: t("tax.manualAdjustmentsDescShort"),
            cls: "text-muted-foreground",
        },
    ];

    return (
        <div className="space-y-4">
            <TaxSummaryCard cards={cards.slice(0, 3)} />
            <dl className="grid gap-4 rounded-lg border border-border/50 p-4 sm:grid-cols-3">
                {cards.slice(3).map((card) => (
                    <div key={card.title} className="space-y-1">
                        <dt className="text-sm text-muted-foreground">
                            {card.title}
                        </dt>
                        <dd className="text-lg font-semibold">{card.value}</dd>
                        <dd className="text-xs text-muted-foreground">
                            {card.desc}
                        </dd>
                    </div>
                ))}
            </dl>
        </div>
    );
}
