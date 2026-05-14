import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Bell, X, CalendarClock } from "lucide-react";
import { useEffect, useState } from "react";
import { formatCurrency } from "@/utils/currency";
import { Link } from "react-router-dom";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import { numberFormatToLocale } from "@/utils/currency";
import { toYmd } from "@/lib/timezone";
import { formatDateStringWithAppSettings } from "@/components/shared/dateUtils";

const DISMISSED_UPCOMING_PLANNED_STORAGE_KEY = "dismissed_upcoming_planned_payments";

export function UpcomingPaymentsNotification() {
  const { t } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = numberFormatToLocale(appSettings.numberFormat);
  const [dismissedIds, setDismissedIds] = useState<Set<number>>(new Set());
  const [dismissedLoaded, setDismissedLoaded] = useState(false);

  const loadDismissedFromLocalStorage = () => {
    try {
      const raw = window.localStorage.getItem(DISMISSED_UPCOMING_PLANNED_STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const values = parsed
          .map((v) => Number(v))
          .filter((v) => Number.isInteger(v) && v > 0);
        setDismissedIds(new Set(values));
      }
    } catch {
      // Ignore invalid localStorage payloads.
    }
  };

  const persistDismissedToLocalStorage = (values: Set<number>) => {
    try {
      window.localStorage.setItem(DISMISSED_UPCOMING_PLANNED_STORAGE_KEY, JSON.stringify([...values]));
    } catch {
      // Ignore storage write failures.
    }
  };

  const dismissById = (plannedPaymentId: number) => {
    const next = new Set(dismissedIds);
    next.add(plannedPaymentId);
    setDismissedIds(next);
    persistDismissedToLocalStorage(next);
  };

  useEffect(() => {
    loadDismissedFromLocalStorage();
    setDismissedLoaded(true);
  }, []);

  const queryDate = toYmd(new Date());

  const { data: upcoming } = useQuery({
    queryKey: ["upcomingPlannedPayments", queryDate],
    queryFn: async () => {
      // Derive the range from queryDate (the key) so the fetched window can't
      // disagree with the cache key across a midnight boundary.
      const nextWeek = new Date(`${queryDate}T00:00:00`);
      nextWeek.setDate(nextWeek.getDate() + 7);

      const response = await apiClient.getPlannedTransactions({
        active: true,
        start_date: queryDate,
        end_date: toYmd(nextWeek),
        limit: 100,
      });

      // Filter out already-executed one-time payments
      return response.items.filter((pt) => !(pt.is_executed && !pt.is_recurring));
    },
    staleTime: 5 * 60_000,
  });

  const visibleUpcoming = (upcoming ?? []).filter((pt) => !dismissedIds.has(pt.id));

  if (!dismissedLoaded || visibleUpcoming.length === 0) return null;

  return (
    <Alert className="relative border-primary/30 bg-primary/5 mb-4">
      <CalendarClock className="h-4 w-4 text-primary" />
      <AlertTitle className="flex items-center gap-2 text-primary font-semibold">
        <Bell className="h-4 w-4" />
        {visibleUpcoming.length === 1
          ? t('upcoming.countSingle', { count: String(visibleUpcoming.length) })
          : t('upcoming.countPlural', { count: String(visibleUpcoming.length) })}
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
                onClick={() => dismissById(pt.id)}
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
        onClick={() => {
          const next = new Set(dismissedIds);
          visibleUpcoming.forEach((pt) => next.add(pt.id));
          setDismissedIds(next);
          persistDismissedToLocalStorage(next);
        }}
      >
        <X className="h-3 w-3" />
      </button>
    </Alert>
  );
}
