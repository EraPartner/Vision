import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Money } from "@/components/shared/Money";
import { CalendarClock, Sparkles, X } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";
import { useUpcomingPlannedPayments } from "@/hooks/useUpcomingPlannedPayments";

const MAX_ROWS = 3;

/**
 * Contextual dashboard suggestion (Siri-suggestion style): appears only when
 * planned payments are due within the next 7 days. Shares its data source and
 * dismissed-ID set with the global UpcomingPaymentsNotification banner, which
 * stands down on the dashboard while this card is the active surface.
 */
export function SuggestionCard() {
  const { t, tc } = useLanguage();
  const { appSettings } = useAppSettings();
  const { visibleUpcoming, dismiss } = useUpcomingPlannedPayments();

  if (visibleUpcoming.length === 0) return null;

  const shown = visibleUpcoming.slice(0, MAX_ROWS);
  const moreCount = visibleUpcoming.length - shown.length;

  return (
    <Card className="glass-elevated premium-frame relative overflow-hidden animate-in">
      <div className="absolute inset-0 pointer-events-none rounded-[inherit] bg-gradient-to-br from-primary/10 to-primary/5" />
      <CardContent className="relative flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4">
        <div className="h-11 w-11 shrink-0 rounded-xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center shadow-[0_2px_8px_-2px_hsl(var(--primary)/0.25)] text-primary">
          <CalendarClock className="h-5 w-5" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-primary/80">
            <Sparkles className="h-3 w-3" />
            {t('suggestions.kicker')}
          </p>
          <p className="mt-0.5 font-display text-sm font-semibold text-foreground">
            {tc('upcoming.count', visibleUpcoming.length)}
          </p>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted-foreground">
            {shown.map((pt) => (
              <span key={pt.id} className="inline-flex max-w-full items-baseline gap-1.5">
                <span className="truncate font-medium text-foreground/90">
                  {pt.memo || pt.recipient_name || t('upcoming.unnamed')}
                </span>
                <span>{formatDateStringWithAppSettings(pt.planned_date, appSettings.dateFormat)}</span>
                <Money
                  amount={Math.abs(pt.amount)}
                  currency={pt.currency || appSettings.defaultCurrency}
                  className="font-semibold text-foreground"
                />
              </span>
            ))}
            {moreCount > 0 && <span>{t('upcoming.more', { n: String(moreCount) })}</span>}
          </div>
        </div>

        <Button asChild size="sm" className="shrink-0 self-start sm:self-center">
          <Link to="/planned">{t('suggestions.review')}</Link>
        </Button>
      </CardContent>

      <button
        type="button"
        className="absolute top-2 right-2 inline-flex items-center justify-center h-6 w-6 rounded-md text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground transition-colors"
        title={t('upcoming.dismissAll')}
        aria-label={t('upcoming.dismissAll')}
        onClick={() => dismiss(visibleUpcoming)}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </Card>
  );
}
