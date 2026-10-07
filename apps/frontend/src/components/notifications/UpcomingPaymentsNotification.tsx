import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { TextLink } from "@/components/shared/TextLink";
import { cn } from "@/lib/utils";
import { ChevronDown, X, CalendarClock } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { formatCurrency } from "@/utils/currency";
import { useLocation } from "react-router";
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
    <Alert className="relative mb-4 border-primary/30 bg-primary/5 pr-12">
      <CalendarClock className="h-4 w-4 text-primary" aria-hidden="true" />
      <AlertTitle className="mb-0 text-primary">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-expanded={expanded}
          aria-controls={detailsId}
          onClick={() => setExpanded(!expanded)}
          className="-mx-2 h-8 gap-2 px-2 type-headline text-primary hover:bg-primary/10 hover:text-primary"
        >
          {tc('upcoming.count', visibleUpcoming.length)}
          <ChevronDown
            aria-hidden="true"
            className={cn("transition-transform duration-fast", expanded && "rotate-180")}
          />
        </Button>
      </AlertTitle>
      <AlertDescription id={detailsId} hidden={!expanded} className="mt-2 space-y-1">
        {sortedUpcoming.slice(0, 5).map((pt) => (
          <div key={pt.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 type-body">
            <span className="font-medium text-foreground">
              {pt.memo || pt.recipient_name || t('upcoming.unnamed')}
            </span>
            <span className="flex items-center gap-2 text-label-secondary">
              <span>{formatDateStringWithAppSettings(pt.planned_date, appSettings.dateFormat)}</span>
              <span className="font-medium tabular-nums text-foreground">
                {formatCurrency(Math.abs(pt.amount), pt.currency || appSettings.defaultCurrency, locale, appSettings.showDecimalPlaces ?? 2)}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0 text-label-secondary hover:text-foreground [&_svg]:size-3"
                title={t('upcoming.dismissPayment', { name: pt.memo || pt.recipient_name || t('upcoming.unnamed') })}
                aria-label={t('upcoming.dismissPayment', { name: pt.memo || pt.recipient_name || t('upcoming.unnamed') })}
                onClick={() => dismiss(pt)}
              >
                <X aria-hidden="true" />
              </Button>
            </span>
          </div>
        ))}
        {visibleUpcoming.length > 5 && (
          <p className="type-footnote text-label-secondary">
            {t('upcoming.more', { n: String(visibleUpcoming.length - 5) })}
          </p>
        )}
        <div className="mt-2">
          <TextLink
            to="/planned"
            className="inline-flex min-h-8 items-center type-footnote font-medium"
          >
            {t('upcoming.viewAllLink')}
          </TextLink>
        </div>
      </AlertDescription>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="absolute right-2 top-2 h-8 w-8 shrink-0 text-label-secondary hover:text-foreground"
        title={t('upcoming.dismissAll')}
        aria-label={t('upcoming.dismissAll')}
        onClick={() => dismiss(visibleUpcoming)}
      >
        <X aria-hidden="true" />
      </Button>
    </Alert>
  );
}
