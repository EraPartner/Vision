import { Info } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from "@/components/ui/table";
import { TouchDisclosure } from "@/components/shared/TouchDisclosure";

interface PitBreakdownCardProps {
    calculation: BelgianTaxCalculation;
    portfolioTaxesForYear: number;
    totalTaxIncludingPortfolio: number;
    totalTaxIncludingPropertyEstimate: number;
    viewedYear: number;
}

type RowType = "base" | "tax" | "reduction" | "total" | "grand";

/** Income tax component table of the budget-tax overview page ("pitBreakdown" widget). */
export function PitBreakdownCard({
    calculation,
    portfolioTaxesForYear,
    totalTaxIncludingPortfolio,
    totalTaxIncludingPropertyEstimate,
    viewedYear,
}: PitBreakdownCardProps) {
    const { t } = useLanguage();
    const fmt = useCurrencyFormatter();

    const pitBreakdownRows: Array<{
        label: string;
        value: number;
        type: RowType;
        bracket?: string;
    }> = [
        {
            label: t("tax.pit.row.taxableIncome"),
            value: calculation.taxableIncome,
            type: "base",
        },
        {
            label: t("tax.pit.row.bracket1"),
            value: calculation.federalPITBracket1,
            type: "tax",
            bracket: t("tax.pit.bracketRange1"),
        },
        {
            label: t("tax.pit.row.bracket2"),
            value: calculation.federalPITBracket2,
            type: "tax",
            bracket: t("tax.pit.bracketRange2"),
        },
        {
            label: t("tax.pit.row.bracket3"),
            value: calculation.federalPITBracket3,
            type: "tax",
            bracket: t("tax.pit.bracketRange3"),
        },
        {
            label: t("tax.pit.row.bracket4"),
            value: calculation.federalPITBracket4,
            type: "tax",
            bracket: t("tax.pit.bracketRange4"),
        },
        {
            label: t("tax.pit.row.federalBefore"),
            value: calculation.federalPITBeforeExemption,
            type: "total",
        },
        {
            label: t("tax.pit.row.personalExemptionBenefit"),
            value: calculation.personalExemptionBenefit,
            type: "reduction",
        },
        {
            label: t("tax.pit.row.federalTaxCredits"),
            value: calculation.federalTaxCredits,
            type: "reduction",
        },
        {
            label: t("tax.pit.row.federalAfter"),
            value: calculation.federalPITAfterReductions,
            type: "total",
        },
        {
            label: t("tax.pit.row.communalSurcharge"),
            value: calculation.communalSurcharge,
            type: "tax",
        },
        {
            label: t("tax.pit.row.specialSS"),
            value: calculation.specialSocialSecurityContribution,
            type: "tax",
        },
        {
            label: t("tax.pit.row.totalPIT"),
            value: calculation.totalPIT,
            type: "grand",
        },
        {
            label: t("tax.pit.row.portfolioTaxesYear", {
                year: String(viewedYear),
            }),
            value: portfolioTaxesForYear,
            type: "tax",
        },
        {
            label: t("tax.pit.row.totalTaxInclPortfolio"),
            value: totalTaxIncludingPortfolio,
            type: "grand",
        },
        // Property tax estimate is informational and shown separately
        {
            label: t("tax.pit.row.propertyTaxEstimate"),
            value: calculation.propertyTaxEstimate,
            type: "tax",
        },
        {
            label: t("tax.pit.row.totalWithPropertyEstimate"),
            value: totalTaxIncludingPropertyEstimate,
            type: "grand",
        },
    ];

    return (
        <Card>
            <CardHeader>
                <CardTitle className="flex items-center gap-2">
                    {t("tax.pit.title")}
                    <TouchDisclosure
                        label={t("tax.pit.tooltip")}
                        content={t("tax.pit.tooltip")}
                        className="text-label-tertiary hover:text-foreground"
                    >
                        <Info className="h-4 w-4" aria-hidden="true" />
                    </TouchDisclosure>
                </CardTitle>
                <CardDescription>{t("tax.pit.description")}</CardDescription>
            </CardHeader>
            <CardContent>
                <Table>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t("tax.pit.table.component")}</TableHead>
                            <TableHead className="text-right">
                                {t("tax.pit.table.amount")}
                            </TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {pitBreakdownRows.map((row) => (
                            <TableRow key={row.label}>
                                <TableCell>
                                    <div className="flex flex-wrap items-center gap-2">
                                        <span
                                            className={cn(
                                                row.type === "grand" &&
                                                    "font-medium text-foreground",
                                            )}
                                        >
                                            {row.label}
                                        </span>
                                        {row.bracket && (
                                            <Badge variant="outline" size="sm">
                                                {row.bracket}
                                            </Badge>
                                        )}
                                    </div>
                                </TableCell>
                                <TableCell
                                    className={cn(
                                        "text-right font-medium tabular-nums",
                                        row.type === "tax" && "text-loss",
                                        row.type === "reduction" && "text-gain",
                                        row.type === "grand" &&
                                            "type-headline text-primary",
                                    )}
                                >
                                    {row.type === "reduction"
                                        ? fmt(row.value, { signed: true })
                                        : fmt(row.value)}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
}
