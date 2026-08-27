import { CircleHelp } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxCalculation } from "@/lib/belgianTax";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tooltip as UITooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface PitBreakdownCardProps {
  calculation: BelgianTaxCalculation;
  portfolioTaxesForYear: number;
  totalTaxIncludingPortfolio: number;
  totalTaxIncludingPropertyEstimate: number;
  viewedYear: number;
}

/** PIT component table of the budget-tax overview page ("pitBreakdown" widget). */
export function PitBreakdownCard({
  calculation,
  portfolioTaxesForYear,
  totalTaxIncludingPortfolio,
  totalTaxIncludingPropertyEstimate,
  viewedYear,
}: PitBreakdownCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  const pitBreakdownRows = [
    { label: t("tax.pit.row.taxableIncome"), value: calculation.taxableIncome, type: "base" as const },
    { label: t("tax.pit.row.bracket1"), value: calculation.federalPITBracket1, type: "tax" as const, bracket: t("tax.pit.bracketRange1") },
    { label: t("tax.pit.row.bracket2"), value: calculation.federalPITBracket2, type: "tax" as const, bracket: t("tax.pit.bracketRange2") },
    { label: t("tax.pit.row.bracket3"), value: calculation.federalPITBracket3, type: "tax" as const, bracket: t("tax.pit.bracketRange3") },
    { label: t("tax.pit.row.bracket4"), value: calculation.federalPITBracket4, type: "tax" as const, bracket: t("tax.pit.bracketRange4") },
    { label: t("tax.pit.row.federalBefore"), value: calculation.federalPITBeforeExemption, type: "total" as const },
    { label: t("tax.pit.row.personalExemptionBenefit"), value: calculation.personalExemptionBenefit, type: "reduction" as const },
    { label: t("tax.pit.row.federalTaxCredits"), value: calculation.federalTaxCredits, type: "reduction" as const },
    { label: t("tax.pit.row.federalAfter"), value: calculation.federalPITAfterReductions, type: "total" as const },
    { label: t("tax.pit.row.communalSurcharge",), value: calculation.communalSurcharge, type: "tax" as const },
    { label: t("tax.pit.row.specialSS"), value: calculation.specialSocialSecurityContribution, type: "tax" as const },
    { label: t("tax.pit.row.totalPIT"), value: calculation.totalPIT, type: "grand" as const },
    { label: t("tax.pit.row.portfolioTaxesYear", { year: String(viewedYear) }), value: portfolioTaxesForYear, type: "tax" as const },
    { label: t("tax.pit.row.totalTaxInclPortfolio"), value: totalTaxIncludingPortfolio, type: "grand" as const },
    // Property tax estimate is informational and shown separately
    { label: t('tax.pit.row.propertyTaxEstimate'), value: calculation.propertyTaxEstimate, type: 'tax' as const },
    { label: t("tax.pit.row.totalWithPropertyEstimate"), value: totalTaxIncludingPropertyEstimate, type: "grand" as const },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t('tax.pit.title')}
          <UITooltip>
            <TooltipTrigger asChild>
              <CircleHelp className="h-4 w-4 text-muted-foreground cursor-help" />
            </TooltipTrigger>
            <TooltipContent className="max-w-xs text-xs">
              {t('tax.pit.tooltip')}
            </TooltipContent>
          </UITooltip>
        </CardTitle>
        <CardDescription>{t('tax.pit.description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('tax.pit.table.component')}</TableHead>
                <TableHead className="text-right">{t('tax.pit.table.amount')}</TableHead>
              </TableRow>
            </TableHeader>
          <TableBody>
            {pitBreakdownRows.map((row) => (
              <TableRow key={row.label}>
                <TableCell>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm">{row.label}</span>
                    {row.bracket && (
                      <Badge variant="outline" className="text-2xs">
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
                    row.type === "grand" && "text-primary font-bold"
                  )}
                >
                  {row.type === "reduction" ? fmt(row.value, { signed: true }) : fmt(row.value)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
