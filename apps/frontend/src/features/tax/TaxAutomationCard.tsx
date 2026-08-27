import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** "What is automatic vs manual" explainer card of the overview page. */
export function TaxAutomationCard() {
  const { t } = useLanguage();
  return (
    <Card className="border-border/70">
        <CardHeader>
        <CardTitle variant="sm">{t('tax.automation.title')}</CardTitle>
        </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">{t('tax.automation.automatic')}:</span> {t('tax.automation.automaticDesc')}
        </p>
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">{t('tax.automation.manualLabel')}:</span> {t('tax.automation.manualDesc')}
        </p>
        <p className="text-muted-foreground">
          <span className="font-semibold text-foreground">{t('tax.automation.investmentLabel')}:</span> {t('tax.automation.investmentDesc')}
        </p>
      </CardContent>
    </Card>
  );
}
