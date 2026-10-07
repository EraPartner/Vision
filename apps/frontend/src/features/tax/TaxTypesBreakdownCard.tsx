import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { CostBreakdownEntry } from "@/hooks/usePortfolioTaxData";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Money } from "@/components/shared/Money";
import { KeyValueRows, type KeyValueRow } from "./KeyValueRows";

interface TaxTypesBreakdownCardProps {
    taxBreakdown: CostBreakdownEntry[];
    feeBreakdown: CostBreakdownEntry[];
    totalRealizedGain: number;
    totalUnrealizedGain: number;
}

function toneClass(value: number): string {
    return value >= 0 ? "text-gain" : "text-loss";
}

/** Per-tax-type and per-fee-type breakdown of the portfolio-tax page ("taxTypes" widget). */
export function TaxTypesBreakdownCard({
    taxBreakdown,
    feeBreakdown,
    totalRealizedGain,
    totalUnrealizedGain,
}: TaxTypesBreakdownCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    const toRows = (entries: CostBreakdownEntry[]): KeyValueRow[] =>
        entries.map(({ name, value }) => ({
            key: name,
            label: name,
            value: fmt(value),
            tone: "text-loss",
        }));

    const gainRows: KeyValueRow[] = [
        {
            key: "realized",
            label: t("portfolio.realizedGains"),
            value: <Money amount={totalRealizedGain} signed />,
            tone: toneClass(totalRealizedGain),
        },
        {
            key: "unrealized",
            label: t("portfolio.unrealizedGains"),
            value: <Money amount={totalUnrealizedGain} signed />,
            tone: toneClass(totalUnrealizedGain),
        },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.widget.taxTypes")}</CardTitle>
                <CardDescription>{t("tax.taxTypesDesc")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                {taxBreakdown.length > 0 && (
                    <section>
                        <h3 className="type-headline text-foreground">
                            {t("tax.taxes")}
                        </h3>
                        <KeyValueRows rows={toRows(taxBreakdown)} />
                    </section>
                )}
                {feeBreakdown.length > 0 && (
                    <section>
                        <h3 className="type-headline text-foreground">
                            {t("tax.fees")}
                        </h3>
                        <KeyValueRows rows={toRows(feeBreakdown)} />
                    </section>
                )}
                <section className="border-t border-border/60 pt-4">
                    <h3 className="type-headline text-foreground">
                        {t("tax.gainsContext")}
                    </h3>
                    <KeyValueRows rows={gainRows} />
                </section>
            </CardContent>
        </Card>
    );
}
