import { useLanguage } from "@/contexts/LanguageContext";
import { useCurrencyFormatter } from "@/hooks/useCurrencyFormatter";
import type { BelgianTaxCalculation, BelgianTaxProfile } from "@/lib/belgianTax";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";

interface TaxCurrentInputsCardProps {
  profile: BelgianTaxProfile;
  calculation: BelgianTaxCalculation;
}

/** Profile inputs + derived burden summary of the overview page. */
export function TaxCurrentInputsCard({ profile, calculation }: TaxCurrentInputsCardProps) {
  const { t } = useLanguage();
  const fmt = useCurrencyFormatter();

  return (
    <Card className="glass-regular">
      <CardHeader>
            <CardTitle>{t('tax.profile.currentInputs')}</CardTitle>
         <CardDescription>{t('tax.profile.currentInputs.desc')}</CardDescription>
         </CardHeader>
        <CardContent className="space-y-3">
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.employmentType')}</span>
          <Badge variant="secondary">{profile.employmentType.replaceAll("_", " ")}</Badge>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.grossAnnualIncome')}</span>
          <span className="font-semibold tabular-nums">{fmt(profile.grossAnnualIncome)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.otherTaxableIncome')}</span>
          <span className="font-semibold tabular-nums">{fmt(profile.otherTaxableIncome)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.professionalExpenses')}</span>
          <span className="font-semibold tabular-nums">
            {profile.professionalExpenseMethod === "lump_sum"
              ? t('tax.profile.field.professionalExpenses.lump')
              : fmt(profile.actualProfessionalExpenses)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.dependents')}</span>
          <span className="font-semibold">
            {profile.dependentChildren} {t('tax.profile.field.children')} / {profile.dependentOtherPersons} {t('tax.profile.field.others')}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.personalExemption')}</span>
          <span className="font-semibold tabular-nums">{fmt(calculation.personalExemptionAmount)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.profile.field.disabilityExemptions')}</span>
          <span className="font-semibold">
            {profile.isDisabled || profile.isSpouseDisabled ? t('common.applied') : t('common.none')}
          </span>
        </div>
        <Separator />
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.pit.row.federalAfter')}</span>
          <span className="font-semibold tabular-nums text-loss">
            {fmt(calculation.federalPITAfterReductions)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.pit.row.communalSurcharge')}</span>
          <span className="font-semibold tabular-nums text-loss">{fmt(calculation.communalSurcharge)}</span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.pit.row.employeeSS')}</span>
          <span className="font-semibold tabular-nums text-loss">
            {fmt(calculation.employeeSocialSecurity)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.pit.row.specialSS')}</span>
          <span className="font-semibold tabular-nums text-loss">
            {fmt(calculation.specialSocialSecurityContribution)}
          </span>
        </div>
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">{t('tax.pit.row.totalBurden')}</span>
          <span className="font-bold tabular-nums text-primary">{fmt(calculation.totalTaxBurden)}</span>
        </div>
        </CardContent>
     </Card>
  );
}
