import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxCalculation, BelgianTaxProfile } from "@/lib/belgianTax";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface PortfolioProfileInputsCardProps {
  profile: BelgianTaxProfile;
  calculation: BelgianTaxCalculation;
}

/** Profile inputs summary of the portfolio-tax page ("profileInputs" widget). */
export function PortfolioProfileInputsCard({ profile, calculation }: PortfolioProfileInputsCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("tax.profile.currentInputs")}</CardTitle>
        <CardDescription>{t("tax.portfolioProfileInputsDesc")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.employmentType")}</span>
          <Badge variant="secondary">{profile.employmentType.replaceAll("_", " ")}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.grossAnnualIncome")}</span>
          <span className="font-semibold tabular-nums">{fmt(profile.grossAnnualIncome)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.otherTaxableIncome")}</span>
          <span className="font-semibold tabular-nums">{fmt(profile.otherTaxableIncome)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.personalExemption")}</span>
          <span className="font-semibold tabular-nums">{fmt(calculation.personalExemptionAmount)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.dependents")}</span>
          <span className="font-semibold">
            {profile.dependentChildren} {t("tax.profile.field.children")} / {profile.dependentOtherPersons} {t("tax.profile.field.others")}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t("tax.profile.field.disabilityExemptions")}</span>
          <span className="font-semibold">{profile.isDisabled || profile.isSpouseDisabled ? t("common.applied") : t("common.none")}</span>
        </div>
      </CardContent>
    </Card>
  );
}
