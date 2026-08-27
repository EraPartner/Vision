import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface RecordedVsManualCardProps {
  totalRecordedTaxes: number;
  totalRecordedFees: number;
  totalManualTaxes: number;
  totalManualFees: number;
  totalTaxesAndFees: number;
}

/** Recorded-vs-manual cost split card of the portfolio-tax page. */
export function RecordedVsManualCard({
  totalRecordedTaxes,
  totalRecordedFees,
  totalManualTaxes,
  totalManualFees,
  totalTaxesAndFees,
}: RecordedVsManualCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.recordedVsManual")}</CardTitle>
        <CardDescription>{t("tax.recordedVsManualDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.recordedTaxes")}</span>
          <span className="font-semibold tabular-nums text-loss">{fmt(totalRecordedTaxes)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.recordedFees")}</span>
          <span className="font-semibold tabular-nums text-loss">{fmt(totalRecordedFees)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.manualTaxAdjustments")}</span>
          <span className="font-semibold tabular-nums text-muted-foreground">{fmt(totalManualTaxes)}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.manualFeeAdjustments")}</span>
          <span className="font-semibold tabular-nums text-muted-foreground">{fmt(totalManualFees)}</span>
        </div>
        <div className="flex justify-between text-sm pt-2 border-t border-border">
          <span className="text-muted-foreground">{t("tax.totalCosts")}</span>
          <span className="font-bold tabular-nums text-primary">{fmt(totalTaxesAndFees)}</span>
        </div>
      </CardContent>
    </Card>
  );
}
