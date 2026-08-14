/**
 * TaxFilingMasthead
 *
 * The tax overview's document head, modelled on the Belgian assessment notice
 * (aanslagbiljet): the income year IS the document, so its identity is stated
 * once, large, and everything that qualifies it hangs off that one block —
 * region, filing status, marginal rate, the effective burden as the single hero
 * figure, the year switcher/actions, and the historical-year notice.
 *
 * It absorbs, verbatim in value and derivation:
 *  - the three outline badges the page used to render (region / marginal rate /
 *    effective burden) — same fields, same `formatPercent` digits;
 *  - `HistoricalYearBannerSection` — same `resolveHistoricalBannerMode` modes,
 *    same `tax.historical.banner.*` strings and the same two actions.
 *
 * No number is computed here. Every figure is a pass-through read of the
 * calculation the page already had.
 */
import { History, Lock, Plus, Snowflake, Sparkles } from 'lucide-react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useBelgianTaxProfile } from '@/contexts/BelgianTaxProfileContext';
import { formatPercent } from '@/utils/currency';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { BelgianTaxCalculation, BelgianTaxProfile } from '@/lib/belgianTax';
import { TaxYearSwitcher } from './TaxYearSwitcher';
import { YearActionsMenu } from './YearActionsMenu';
import { resolveHistoricalBannerMode } from './historicalBannerMode';
import type { HistoricalYearBannerMode } from './HistoricalYearBanner';

/** `live` = the year the profile is actually on; the rest mirror the banner modes. */
type FilingStatus = 'live' | HistoricalYearBannerMode;

const STATUS_ICON: Record<FilingStatus, typeof History> = {
    live: Sparkles,
    estimate: History,
    snapshot: History,
    frozen: Snowflake,
    filed: Lock,
};

/** Jewel/warning accents from the ADR-105 palette — one tone per document state. */
const STATUS_CLASS: Record<FilingStatus, string> = {
    live: 'border-primary/40 bg-primary/10 text-primary',
    estimate: 'border-border bg-secondary/60 text-muted-foreground',
    snapshot: 'border-primary/30 bg-primary/5 text-primary',
    frozen: 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300',
    filed: 'border-warning/40 bg-warning/10 text-warning',
};

interface TaxFilingMastheadProps {
    /** Profile for the viewed year — only its `region` is read. */
    profile: BelgianTaxProfile;
    /** Display calculation for the viewed year — only its two rates are read. */
    calculation: BelgianTaxCalculation;
}

export function TaxFilingMasthead({ profile, calculation }: TaxFilingMastheadProps) {
    const { t } = useLanguage();
    const {
        profile: liveProfile,
        viewedYear,
        setViewedYear,
        isViewingHistorical,
        snapshotExistsForYear,
        createSnapshotFromLive,
        isYearFiled,
        getFrozenCalculation,
        metaForYear,
    } = useBelgianTaxProfile();

    const historical = isViewingHistorical
        ? resolveHistoricalBannerMode({
              isFiled: isYearFiled(viewedYear),
              hasFrozenCalculation: getFrozenCalculation(viewedYear) != null,
              hasSnapshot: snapshotExistsForYear(viewedYear),
              filingReference: metaForYear(viewedYear)?.filing?.reference,
          })
        : undefined;

    const status: FilingStatus = historical?.mode ?? 'live';
    const StatusIcon = STATUS_ICON[status];

    return (
        <section
            aria-labelledby="tax-filing-year"
            className="canvas-text glass-elevated premium-frame relative overflow-hidden rounded-[0.75rem]"
        >
            {/* Document wash: a jewel-emerald corner light plus a champagne bloom,
                both purely decorative and non-interactive. */}
            <div
                aria-hidden
                className="pointer-events-none absolute inset-0 rounded-[inherit] bg-[radial-gradient(125%_150%_at_0%_0%,hsl(var(--primary)/0.10),transparent_62%)]"
            />
            <div
                aria-hidden
                className="pointer-events-none absolute -right-24 -top-28 h-64 w-64 rounded-full bg-gradient-to-br from-accent/20 to-transparent blur-3xl"
            />

            <div className="relative p-5 sm:p-6">
                <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:justify-between">
                    {/* ── Identity: the year, its state, and the year controls ── */}
                    <div className="min-w-0">
                        <p className="text-[0.6875rem] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            {t('tax.masthead.eyebrow')}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-2">
                            <h2
                                id="tax-filing-year"
                                className="font-display text-5xl font-semibold leading-none tracking-tight tabular-nums text-foreground sm:text-6xl"
                            >
                                {viewedYear}
                            </h2>
                            <span
                                className={cn(
                                    'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.6875rem] font-semibold uppercase tracking-wider',
                                    STATUS_CLASS[status],
                                )}
                            >
                                <StatusIcon className="h-3 w-3" aria-hidden />
                                <span className="sr-only">{t('tax.masthead.statusLabel')}: </span>
                                {t(`tax.masthead.status.${status}`)}
                            </span>
                        </div>
                        <div className="mt-4 flex flex-wrap items-center gap-2">
                            <TaxYearSwitcher />
                            <YearActionsMenu year={viewedYear} />
                        </div>
                    </div>

                    {/* ── Figures: two qualifiers, then the single hero number ── */}
                    <dl className="flex flex-wrap items-end gap-x-8 gap-y-5">
                        <div className="min-w-0">
                            <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                {t('tax.masthead.meta.region')}
                            </dt>
                            {/* Resolves the stored enum through the same
                                `tax.profile.region.*.label` keys RegionStep uses, so it
                                reads "Flanders (Vlaanderen)" rather than `flanders`. */}
                            <dd className="mt-1.5 text-sm font-semibold text-foreground">
                                {t(`tax.profile.region.${profile.region}.label`)}
                            </dd>
                        </div>
                        <div>
                            <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                {t('tax.masthead.meta.marginalRate')}
                            </dt>
                            <dd className="mt-1.5 text-sm font-semibold tabular-nums text-foreground">
                                {formatPercent(calculation.marginalRate, { digits: 0 })}
                            </dd>
                        </div>
                        <div className="border-border/60 sm:border-l sm:pl-8">
                            <dt className="text-[0.6875rem] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                {t('tax.masthead.meta.effectiveBurden')}
                            </dt>
                            <dd className="mt-1 font-display text-4xl font-semibold leading-none tracking-tight tabular-nums text-primary sm:text-5xl">
                                {formatPercent(calculation.effectiveRate, { digits: 1 })}
                            </dd>
                        </div>
                    </dl>
                </div>

                {/* ── Historical-year notice (was HistoricalYearBanner) ── */}
                {historical && (
                    <div className="mt-5 flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-xs text-muted-foreground">
                            <span className="font-semibold text-foreground">
                                {t(`tax.historical.banner.${historical.mode}Title`, {
                                    year: String(viewedYear),
                                })}
                            </span>{' '}
                            {t(`tax.historical.banner.${historical.mode}Desc`, {
                                year: String(viewedYear),
                            })}
                            {historical.mode === 'filed' && historical.filingReference && (
                                <span className="ml-1 font-medium text-warning">
                                    ({t('tax.historical.banner.filedReferencePrefix')}:{' '}
                                    {historical.filingReference})
                                </span>
                            )}
                        </p>
                        <span className="flex shrink-0 items-center gap-2">
                            {historical.mode === 'estimate' && (
                                <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => createSnapshotFromLive(viewedYear)}
                                    className="gap-1"
                                >
                                    <Plus className="h-3 w-3" />
                                    {t('tax.historical.banner.createCta', { year: String(viewedYear) })}
                                </Button>
                            )}
                            <Button size="sm" variant="ghost" onClick={() => setViewedYear(liveProfile.taxYear)}>
                                {t('tax.historical.banner.returnCta', { year: String(liveProfile.taxYear) })}
                            </Button>
                        </span>
                    </div>
                )}
            </div>
        </section>
    );
}
