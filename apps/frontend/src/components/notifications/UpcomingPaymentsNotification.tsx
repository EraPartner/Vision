import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Bell, X, CalendarClock } from "lucide-react";
import { useEffect } from "react";
import { formatCurrency } from "@/utils/currency";
import { Link, useLocation } from "react-router";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
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
      <AlertTitle className="flex items-center gap-2 text-primary font-semibold">
        <Bell className="h-4 w-4" />
        {tc('upcoming.count', visibleUpcoming.length)}
      </AlertTitle>
      <AlertDescription className="mt-2 space-y-1">
        {visibleUpcoming.slice(0, 5).map((pt) => (
          <div key={pt.id} className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {pt.memo || pt.recipient_name || t('upcoming.unnamed')}
            </span>
            <span className="flex items-center gap-2 text-muted-foreground">
              <span>{formatDateStringWithAppSettings(pt.planned_date, appSettings.dateFormat)}</span>
              <span className="font-semibold text-foreground">
                {formatCurrency(Math.abs(pt.amount), pt.currency || appSettings.defaultCurrency, locale)}
              </span>
              <button
                type="button"
                className="inline-flex items-center justify-center h-5 w-5 rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                title={t('recurring.dismiss')}
                aria-label={t('recurring.dismiss')}
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
            className="text-xs text-primary hover:underline font-medium"
          >
            {t('upcoming.viewAllLink')}
          </Link>
        </div>
      </AlertDescription>
      <button
        type="button"
        className="absolute top-2 right-2 inline-flex items-center justify-center h-5 w-5 rounded-sm text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
        title={t('upcoming.dismissAll')}
        aria-label={t('upcoming.dismissAll')}
        onClick={() => dismiss(visibleUpcoming)}
      >
        <X className="h-3 w-3" />
      </button>
    </Alert>
  );
}
