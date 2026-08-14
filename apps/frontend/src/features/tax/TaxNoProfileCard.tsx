import { Calculator, Landmark } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";

/** Empty state of the overview page when no tax profile or stats data exists yet. */
export function TaxNoProfileCard() {
  const { t } = useLanguage();
  return (
    <Card className="glass-regular">
      <CardContent className="flex flex-col items-center justify-center py-16 text-center">
        <Landmark className="h-12 w-12 text-muted-foreground/40 mb-4" />
          <h3 className="text-lg font-semibold text-foreground mb-1">{t('tax.noProfile.title')}</h3>
         <p className="text-muted-foreground text-sm max-w-sm mb-4">{t('tax.noProfile.desc')}</p>
         <TaxProfileDialog
           trigger={
             <Button size="sm" className="gap-2">
               <Calculator className="h-4 w-4" />
               {t('tax.profile.setup')}
             </Button>
           }
         />
      </CardContent>
    </Card>
  );
}
