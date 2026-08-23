import { useMemo } from "react";
import { AlertCircle, CalendarCheck2, CalendarClock, CheckCircle2, Repeat } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { CardSheen } from "@/components/shared/CardSheen";
import { TrendHue } from "@/components/shared/TrendHue";
import { Money } from "@/components/shared/Money";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAppSettings } from "@/contexts/AppSettingsContext";
import {
  appLanguageToLocale,
  formatDateStringWithAppSettings,
  toYmd,
} from "@/components/shared/dateUtils";
import { bucketNextSevenDays, WINDOW_DAYS } from "./nextSevenDays";
import { sumConvertedAmounts } from "./plannedCurrencyTotals";
import type { PlannedPayment } from "@/hooks/usePlannedPayments";
import { cn } from "@/lib/utils";

/**
 * The Planned page's opening statement: the eight calendar days from today
 * through today+7, with every active payment due in that window sitting on the
 * day it falls.
 *
 * It replaced three count tiles ("Pending: 7", "Executed: 3", "Due this week:
 * 2") — a bills page's job is to tell you what is about to leave the account,
 * not how many rows a table has. "Est. monthly" survives as the one side figure
 * because it is the only aggregate here that a count cannot express.
 *
 * Date semantics live in `nextSevenDays.ts` and are lifted verbatim from the
 * tile they replace — same `is_active` filter, same local-midnight Y-M-D parse,
 * same 0…7-day span.
 */

interface NextSevenDaysStripProps {
  payments: PlannedPayment[];
  /** Net monthly impact of active recurring rows, already converted to the display currency. */
  estimatedMonthly: number;
  /** Active recurring rows omitted from the monthly total because an FX rate is unavailable. */
  estimatedMonthlyUnavailableCount: number;
  /** True while the shared FX query is still resolving. */
  currencyRatesLoading: boolean;
  /** The page's optional FX converter — the same one "Est. monthly" is summed with. */
  convertAmount: (amount: number, fromCurrency?: string) => number | undefined;
  /** Open a due item for editing — same target as the row's pencil action. */
  onSelect: (payment: PlannedPayment) => void;
}

export function NextSevenDaysStrip({
  payments,
  estimatedMonthly,
  estimatedMonthlyUnavailableCount,
  currencyRatesLoading,
  convertAmount,
  onSelect,
}: NextSevenDaysStripProps) {
  const { t, tc, language } = useLanguage();
  const { appSettings } = useAppSettings();
  const locale = appLanguageToLocale(language);

  const buckets = useMemo(() => bucketNextSevenDays(payments, new Date()), [payments]);
  const dueCount = buckets.reduce((n, b) => n + b.items.length, 0);
  const windowTotal = useMemo(
    () => sumConvertedAmounts(buckets.flatMap((bucket) => bucket.items), convertAmount),
    [buckets, convertAmount],
  );

  const weekdayFormat = useMemo(
    () => new Intl.DateTimeFormat(locale, { weekday: "short" }),
    [locale],
  );

  const rangeLabel = t("plannedPage.next7.range", {
    from: formatDateStringWithAppSettings(toYmd(buckets[0].date), appSettings.dateFormat),
    to: formatDateStringWithAppSettings(
      toYmd(buckets[WINDOW_DAYS - 1].date),
      appSettings.dateFormat,
    ),
  });

  return (
    <Card className="glass-elevated premium-frame group relative overflow-hidden">
      <TrendHue tone="neutral" />
      <CardSheen animated />

      <CardContent className="relative p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              <CalendarClock className="h-3.5 w-3.5 text-primary" />
              {t("plannedPage.next7.title")}
            </h2>
            <p className="mt-2 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="font-semibold text-foreground">
                {tc("plannedPage.next7.dueCount", dueCount)}
              </span>
              {dueCount > 0 && (
                <>
                  <span className="text-muted-foreground/60">·</span>
                  {currencyRatesLoading ? (
                    <span role="status" aria-label={t("common.loading")}>
                      <Skeleton aria-hidden className="inline-block h-4 w-20 align-middle" />
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "font-semibold tabular-nums",
                        windowTotal.total < 0 ? "amount-loss" : "amount-gain",
                      )}
                    >
                      <Money amount={windowTotal.total} signed />
                    </span>
                  )}
                </>
              )}
              <span className="text-muted-foreground/60">·</span>
              <span className="text-muted-foreground">{rangeLabel}</span>
            </p>
            {!currencyRatesLoading && windowTotal.unavailableCount > 0 && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-warning">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {tc("plannedPage.fxUnavailable", windowTotal.unavailableCount)}
              </p>
            )}
          </div>

          {/* The one surviving aggregate — deliberately a side figure, not a tile. */}
          <div className="max-w-full shrink-0 text-right">
            <p className="flex items-center justify-end gap-1.5 text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
              <Repeat className="h-3 w-3" />
              {t("plannedPage.estMonthly")}
            </p>
            {currencyRatesLoading ? (
              <div className="mt-1 flex justify-end" role="status" aria-label={t("common.loading")}>
                <Skeleton aria-hidden className="h-7 w-24" />
              </div>
            ) : (
              <p
                className={cn(
                  "mt-1 text-2xl font-bold tabular-nums",
                  estimatedMonthly < 0 ? "amount-loss" : "amount-gain",
                )}
              >
                <Money amount={estimatedMonthly} signed />
              </p>
            )}
            {!currencyRatesLoading && estimatedMonthlyUnavailableCount > 0 && (
              <p className="mt-1 flex items-center justify-end gap-1.5 text-xs text-warning">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {tc("plannedPage.fxUnavailable", estimatedMonthlyUnavailableCount)}
              </p>
            )}
          </div>
        </div>

        <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
          {buckets.map((bucket) => {
            const isToday = bucket.offset === 0;
            const shown = bucket.items.slice(0, 2);
            const overflow = bucket.items.length - shown.length;
            return (
              <li
                key={bucket.offset}
                className={cn(
                  "flex min-h-[6.5rem] flex-col gap-1.5 rounded-[0.625rem] border p-2 transition-colors",
                  isToday
                    ? "border-primary/45 bg-primary/[0.07]"
                    : bucket.items.length > 0
                      ? "border-border/70 bg-card/50"
                      : "border-border/40 bg-transparent",
                )}
              >
                <div className="flex items-baseline justify-between gap-1">
                  <span
                    className={cn(
                      "text-[10px] uppercase tracking-[0.08em]",
                      isToday ? "font-semibold text-primary" : "text-muted-foreground",
                    )}
                  >
                    {isToday ? t("plannedPage.next7.today") : weekdayFormat.format(bucket.date)}
                  </span>
                  <span
                    className={cn(
                      "text-sm font-semibold tabular-nums",
                      isToday ? "text-primary" : "text-foreground/80",
                    )}
                  >
                    {bucket.date.getDate()}
                  </span>
                </div>

                {bucket.items.length === 0 ? (
                  <span
                    aria-hidden
                    className="mt-auto mb-1 h-1 w-1 self-center rounded-full bg-muted-foreground/25"
                  />
                ) : (
                  shown.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => onSelect(p)}
                      title={t("plannedPage.next7.itemTitle", { name: p.name })}
                      className="group/item rounded-md px-1 py-0.5 text-left transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span
                        className={cn(
                          "flex items-center gap-1 truncate text-[11px]",
                          p.is_executed
                            ? "text-muted-foreground line-through"
                            : "text-foreground group-hover/item:text-primary",
                        )}
                      >
                        {p.is_executed && <CheckCircle2 className="h-3 w-3 shrink-0 text-accent" />}
                        {p.name}
                      </span>
                      <span
                        className={cn(
                          "block text-[11px] font-semibold tabular-nums",
                          p.amount < 0 ? "text-loss" : "text-gain",
                        )}
                      >
                        {p.amount < 0 ? "−" : "+"}
                        <Money amount={Math.abs(p.amount)} currency={p.currency} />
                      </span>
                    </button>
                  ))
                )}

                {overflow > 0 && (
                  <span className="px-1 text-[10px] text-muted-foreground">
                    {t("plannedPage.next7.more", { n: overflow })}
                  </span>
                )}
              </li>
            );
          })}
        </ol>

        {dueCount === 0 && (
          <div className="mt-3 flex items-center gap-2.5 rounded-[0.625rem] border border-dashed border-border/70 px-3 py-2.5">
            <CalendarCheck2 className="h-4 w-4 shrink-0 text-accent" />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {t("plannedPage.next7.emptyTitle")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("plannedPage.next7.emptyDesc")}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
