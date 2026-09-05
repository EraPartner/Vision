import { ListChecks } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { Button } from "@/components/ui/button";
import { TaxProfileDialog } from "@/features/tax/TaxProfileDialog";
import { EmptyState } from "@/components/shared/EmptyState";

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
    <EmptyState
      size="compact"
      headingLevel={4}
      icon={ListChecks}
      title={t('tax.incomeBreakdown.emptyTitle')}
      description={t('tax.incomeBreakdown.emptyDesc')}
      action={<TaxProfileDialog
        initialStep="incomeSources"
        targetYear={viewedYear}
        trigger={
          <Button size="sm" variant="outline" className="gap-2">
            <ListChecks className="h-4 w-4" />
            {t('tax.incomeBreakdown.emptyCta')}
          </Button>
        }
      />}
    />
  );
}
