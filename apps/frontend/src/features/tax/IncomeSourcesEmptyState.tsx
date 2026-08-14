import { ListChecks } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";

interface IncomeSourcesEmptyStateProps {
  viewedYear: number;
}

/**
 * Empty state shown inside the income charts when the user hasn't flagged any
 * categories as taxable income yet; CTAs straight into the income-sources step.
 */
export function IncomeSourcesEmptyState({ viewedYear }: IncomeSourcesEmptyStateProps) {
  const { t } = useLanguage();
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-4">
      <ListChecks className="h-10 w-10 text-muted-foreground/40 mb-3" />
      <h4 className="text-sm font-semibold text-foreground mb-1">
        {t('tax.incomeBreakdown.emptyTitle')}
      </h4>
      <p className="text-xs text-muted-foreground max-w-xs mb-4">
        {t('tax.incomeBreakdown.emptyDesc')}
      </p>
      <TaxProfileDialog
        initialStep="incomeSources"
        targetYear={viewedYear}
        trigger={
          <Button size="sm" variant="outline" className="gap-2">
            <ListChecks className="h-4 w-4" />
            {t('tax.incomeBreakdown.emptyCta')}
          </Button>
        }
      />
    </div>
  );
}
