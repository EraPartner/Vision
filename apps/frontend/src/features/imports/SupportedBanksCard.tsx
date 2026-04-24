import { useLanguage } from "@/contexts/LanguageContext";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2 } from "lucide-react";
import { useAdapters } from "./useAdapters";

export function SupportedBanksCard() {
  const { t } = useLanguage();
  const { adapters, loading } = useAdapters();

  return (
    <Card className="bg-muted/30">
      <CardContent className="pt-6">
        <p className="text-sm font-semibold text-foreground mb-2">
          {t('importPage.supportedBanks')}
        </p>
        <div className="flex flex-wrap gap-2">
          {loading ? (
            <span className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              <Loader2 className="h-4 w-4 mr-2 animate-spin" /> {t('importPage.supportedLoading')}
            </span>
          ) : adapters.length > 0 ? (
            adapters.map((adapter) => (
              <span
                key={adapter.key}
                className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary"
              >
                {adapter.name}
              </span>
            ))
          ) : (
            <span className="text-xs text-muted-foreground">{t('importPage.noSupportedParsers')}</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-3">{t('importPage.noSupportedBank')}</p>
      </CardContent>
    </Card>
  );
}
