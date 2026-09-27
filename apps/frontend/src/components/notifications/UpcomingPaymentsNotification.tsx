import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { ChevronDown, X, CalendarClock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatCurrency } from "@/utils/currency";
import { Link, useLocation } from "react-router";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useAppSettings } from "@/stores/hydration/AppSettingsHydration";
import { numberFormatToLocale } from "@/utils/currency";
import { formatDateStringWithAppSettings } from "@/lib/dateUtils";
import { setDockBadge } from "@/lib/api/electron";
import { useUpcomingPlannedPayments } from "@/hooks/useUpcomingPlannedPayments";

export function UpcomingPaymentsNotification() {
  const { t, tc } = useLanguage();
  const { pathname } = useLocation();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const { upcoming, visibleUpcoming, dismiss } = useUpcomingPlannedPayments();

  const [expanded, setExpanded] = useState(false);
  const detailsId = useId();
  const sortedUpcoming = [...visibleUpcoming].sort((a, b) => a.planned_date.localeCompare(b.planned_date));

  // Native dock/taskbar badge mirrors the visible (non-dismissed) due count.
  const badgeCount = upcoming !== undefined ? visibleUpcoming.length : null;
  useEffect(() => {
    if (badgeCount === null) return;
    setDockBadge(badgeCount);
  }, [badgeCount]);
  useEffect(() => {
    return () => { setDockBadge(0); };
  }, []);

  if (visibleUpcoming.length === 0 || pathname !== "/") return null;

  return (
    <Alert className="relative border-primary/30 bg-primary/5 mb-4">
      <CalendarClock className="h-4 w-4 text-primary" />
      <AlertTitle className="mb-0 pr-8 text-primary font-semibold">
        <button type="button" aria-expanded={expanded} aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
          className="flex min-h-8 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {tc('upcoming.count', visibleUpcoming.length)}
          <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${expanded ? "rotate-180" : ""}`} />
        </button>
      </AlertTitle>
      <AlertDescription id={detailsId} hidden={!expanded} className="mt-2 space-y-1">
        {sortedUpcoming.slice(0, 5).map((pt) => (
          <div key={pt.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
            <span className="font-medium">
              {pt.memo || pt.recipient_name || t('upcoming.unnamed')}
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span>{formatDateStringWithAppSettings(pt.planned_date, appSettings.dateFormat)}</span>
              <span className="font-semibold text-foreground">
                {formatCurrency(Math.abs(pt.amount), pt.currency || appSettings.defaultCurrency, locale, appSettings.showDecimalPlaces ?? 2)}
              </span>
              <button
                type="button"
                className="inline-flex items-center justify-center h-8 w-8 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                title={t('upcoming.dismissPayment', { name: pt.memo || pt.recipient_name || t('upcoming.unnamed') })}
                aria-label={t('upcoming.dismissPayment', { name: pt.memo || pt.recipient_name || t('upcoming.unnamed') })}
                onClick={() => dismiss(pt)}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          </div>
        ))}
        {visibleUpcoming.length > 5 && (
          <p className="text-xs text-muted-foreground">
            {t('upcoming.more', { n: String(visibleUpcoming.length - 5) })}
          </p>
        )}
        <div className="mt-2">
          <Link
            to="/planned"
            className="text-xs text-primary hover:underline font-medium inline-flex min-h-8 items-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t('upcoming.viewAllLink')}
          </Link>
        </div>
      </AlertDescription>
      <button
        type="button"
        className="absolute top-2 right-2 inline-flex items-center justify-center h-8 w-8 shrink-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title={t('upcoming.dismissAll')}
        aria-label={t('upcoming.dismissAll')}
        onClick={() => dismiss(visibleUpcoming)}
      >
        <X className="h-3 w-3" />
      </button>
    </Alert>
  );
}
