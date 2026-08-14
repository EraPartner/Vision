import { useMemo, useState, type ReactNode } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { CardSheen } from "@/components/shared/CardSheen";
import { TrendHue } from "@/components/shared/TrendHue";
import { DeltaPill } from "@/components/shared/DeltaPill";
import { Money } from "@/components/shared/Money";
import { RollingNumber } from "@/components/shared/RollingNumber";
import { useChartKeyboardNav } from "@/components/charts/keyboardNav";
import { useLanguage } from "@/contexts/LanguageContext";
import { appLanguageToLocale } from "@/components/shared/dateUtils";
import { useChartCurrencyFormatter } from "@/hooks/useChartCurrencyFormatter";
import { formatPeriodLabel } from "./statisticsUtils";
import type { StatisticsData } from "@/hooks/useStatistics";
import { cn } from "@/lib/utils";

/**
 * The Statistics page's opening statement.
 *
 * It replaced a four-tile summary row whose first three tiles restated the
 * dashboard hero (total income / total spending / net) and whose fourth was
 * "Months tracked" — page metadata minted to fill the grid. This lede shows the
 * one thing the page is actually about: the *shape* of the months. The headline
 * is the latest month's net (scrub the strip to walk back through the series),
 * and the three facts underneath are extremes and a hit-rate that exist nowhere
 * else in the app.
 *
 * Arithmetic is read straight off `data.monthlyData` — the same rows the
 * monthly/net charts below plot; nothing is re-derived or re-signed here.
 */

interface MonthlyRhythmProps {
  data: StatisticsData;
}

export function MonthlyRhythm({ data }: MonthlyRhythmProps) {
  const { t, language } = useLanguage();
  const { formatCompact } = useChartCurrencyFormatter();
  const monthLocale = appLanguageToLocale(language);

  const months = data.monthlyData;
  const lastIndex = months.length - 1;

  // Hovering / arrowing the strip walks the headline back through the series;
  // leaving or Escape snaps it to the most recent month.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { onKeyDown, onBlur } = useChartKeyboardNav({
    pointCount: months.length,
    index: activeIndex,
    onIndexChange: setActiveIndex,
    onClear: () => setActiveIndex(null),
  });

  const extremes = useMemo(() => {
    if (months.length === 0) return undefined;
    let best = months[0];
    let worst = months[0];
    let positive = 0;
    for (const m of months) {
      if (m.net > best.net) best = m;
      if (m.net < worst.net) worst = m;
      if (m.net >= 0) positive += 1;
    }
    return { best, worst, positive };
  }, [months]);

  if (months.length === 0 || !extremes) return null;

  const shownIndex = activeIndex ?? lastIndex;
  const shown = months[shownIndex];
  const previous = shownIndex > 0 ? months[shownIndex - 1] : undefined;
  const delta = previous ? shown.net - previous.net : undefined;

  const netCompact = formatCompact(shown.net);
  const deltaCompact = delta !== undefined ? formatCompact(delta) : undefined;

  const shownLabel = formatPeriodLabel(shown.period, monthLocale);
  const maxAbsNet = Math.max(...months.map((m) => Math.abs(m.net)), 1);

  const scrubbing = activeIndex !== null;

  return (
    <Card
      variant="interactive"
      className="glass-elevated premium-frame group relative overflow-hidden"
    >
      <TrendHue tone={shown.net >= 0 ? "gain" : "loss"} />
      <CardSheen animated />

      <CardContent className="relative p-6 pt-6">
        <div className="grid gap-6 lg:grid-cols-[minmax(0,19rem)_minmax(0,1fr)] lg:gap-10">
          {/* ── Headline: the scrubbed month's net ───────────────────────── */}
          <div className="flex flex-col">
            <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-muted-foreground">
              {t("statsPage.rhythm.title")}
            </h2>

            <div className="mt-3 flex items-end gap-3 flex-wrap">
              <span
                className={cn(
                  "text-4xl md:text-5xl font-bold tabular-nums",
                  shown.net >= 0 ? "amount-gain" : "amount-loss",
                )}
                title={netCompact.isCompact ? netCompact.full : undefined}
              >
                <RollingNumber parts={netCompact.parts} />
              </span>
              {delta !== undefined && deltaCompact && (
                <DeltaPill
                  value={delta}
                  label={`${delta > 0 ? "+" : ""}${deltaCompact.display}`}
                  className="mb-1.5"
                />
              )}
            </div>

            <p className="mt-1.5 text-sm text-muted-foreground">
              {t("statsPage.rhythm.netIn", { month: shownLabel })}
              {previous && (
                <span className="text-muted-foreground/70">
                  {" · "}
                  {t("statsPage.rhythm.vsPrevious")}
                </span>
              )}
            </p>

            {/* Detail figures render exact (Money); only the hero abbreviates. */}
            <dl className="mt-5 flex flex-wrap items-baseline gap-x-8 gap-y-2 border-t border-border/50 pt-4">
              <div>
                <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {t("statsPage.rhythm.typicalIn")}
                </dt>
                <dd className="text-sm font-semibold text-gain">
                  <Money amount={data.averageMonthlyIncome} />
                </dd>
              </div>
              <div>
                <dt className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">
                  {t("statsPage.rhythm.typicalOut")}
                </dt>
                <dd className="text-sm font-semibold text-loss">
                  <Money amount={data.averageMonthlySpending} />
                </dd>
              </div>
            </dl>
          </div>

          {/* ── The strip: one net bar per month, above/below zero ────────── */}
          <div
            className="flex flex-col justify-end select-none cursor-crosshair"
            role="group"
            tabIndex={0}
            aria-label={t("statsPage.rhythm.stripAria", { n: months.length })}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            onPointerLeave={() => setActiveIndex(null)}
          >
            <div className="relative h-32">
              <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-foreground/15" aria-hidden />
              <div className="absolute inset-0 flex items-stretch gap-[3px]">
                {months.map((m, i) => {
                  const pct = (Math.abs(m.net) / maxAbsNet) * 50;
                  const isLatest = i === lastIndex;
                  const active = scrubbing && i === shownIndex;
                  return (
                    <div
                      key={m.period}
                      className="relative flex-1 min-w-[3px]"
                      onPointerEnter={() => setActiveIndex(i)}
                      aria-hidden
                    >
                      <div
                        className={cn(
                          "absolute left-0 right-0 transition-opacity duration-200",
                          m.net >= 0
                            ? "bottom-1/2 rounded-t-[3px] bg-gain"
                            : "top-1/2 rounded-b-[3px] bg-loss",
                          // At rest the latest month reads brightest — it is the
                          // one the headline is showing. Scrubbing dims the rest.
                          active || (!scrubbing && isLatest)
                            ? "opacity-100"
                            : scrubbing
                              ? "opacity-35"
                              : "opacity-70",
                        )}
                        style={{ height: `${Math.max(pct, 1.5)}%` }}
                      />
                      {active && (
                        <div className="absolute inset-y-0 -inset-x-px rounded-[4px] ring-1 ring-inset ring-primary/45" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>{formatPeriodLabel(months[0].period, monthLocale)}</span>
              <span className={cn("font-medium", scrubbing ? "text-foreground" : "text-muted-foreground")}>
                {scrubbing ? shownLabel : t("statsPage.rhythm.scrubHint")}
              </span>
              <span>{formatPeriodLabel(months[lastIndex].period, monthLocale)}</span>
            </div>
          </div>
        </div>

        {/* ── Three facts only this page can tell ─────────────────────────── */}
        <div className="mt-6 grid gap-4 border-t border-border/50 pt-4 sm:grid-cols-3">
          <Fact
            label={t("statsPage.rhythm.strongest")}
            value={<Money amount={extremes.best.net} signed />}
            valueClassName={extremes.best.net >= 0 ? "amount-gain" : "amount-loss"}
            hint={formatPeriodLabel(extremes.best.period, monthLocale)}
          />
          <Fact
            label={t("statsPage.rhythm.toughest")}
            value={<Money amount={extremes.worst.net} signed />}
            valueClassName={extremes.worst.net >= 0 ? "amount-gain" : "amount-loss"}
            hint={formatPeriodLabel(extremes.worst.period, monthLocale)}
          />
          <Fact
            label={t("statsPage.rhythm.inTheBlack")}
            value={`${extremes.positive}/${months.length}`}
            valueClassName="text-primary"
            hint={t("statsPage.rhythm.inTheBlackHint")}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Fact({
  label,
  value,
  valueClassName,
  hint,
}: {
  label: string;
  value: ReactNode;
  valueClassName?: string;
  hint: string;
}) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className={cn("mt-0.5 text-lg font-semibold tabular-nums", valueClassName)}>{value}</p>
      <p className="text-xs text-muted-foreground/80">{hint}</p>
    </div>
  );
}
