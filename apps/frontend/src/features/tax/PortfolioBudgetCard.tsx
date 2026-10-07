import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { KeyValueRows } from "./KeyValueRows";

interface PortfolioBudgetCardProps {
    totalPIT: number;
    totalTaxes: number;
    portfolioTaxesPlusPIT: number;
}

/** Income tax plus portfolio-tax total card of the portfolio-tax page. */
export function PortfolioBudgetCard({
    totalPIT,
    totalTaxes,
    portfolioTaxesPlusPIT,
}: PortfolioBudgetCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("tax.budgetTitle")}</CardTitle>
                <CardDescription>
                    {t("tax.portfolioBudgetLikeDesc")}
                </CardDescription>
            </CardHeader>
            <CardContent>
                <KeyValueRows
                    rows={[
                        {
                            key: "incomeTax",
                            label: t("tax.card.totalPIT"),
                            value: fmt(totalPIT),
                            tone: "text-loss",
                        },
                        {
                            key: "portfolioTaxes",
                            label: t("tax.totalTaxesPaid"),
                            value: fmt(totalTaxes),
                            tone: "text-loss",
                        },
                        {
                            key: "total",
                            label: t("tax.totalWithPIT"),
                            value: fmt(portfolioTaxesPlusPIT),
                            tone: "text-primary",
                            emphasis: true,
                        },
                    ]}
                />
            </CardContent>
        </Card>
    );
}
