/**
 * TaxFilingMasthead
 *
 * The tax overview's hero, modelled on the Belgian assessment notice
 * (aanslagbiljet): the income year IS the document, so its identity is stated
 * once, large, and everything that qualifies it hangs off that one block —
 * filing status, region, marginal rate, the effective burden as the single hero
 * figure, and the historical-year notice with its two actions.
 *
 * No number is computed here. Every figure is a pass-through read of the
 * calculation the page already had. The year switcher and the year actions
 * live in the page header.
 */
import { History, Lock, Plus, Snowflake, Sparkles } from "lucide-react";
import { useLanguage } from "@/stores/hydration/LanguageHydration";
import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { Button } from "@/components/ui/button";
import { Badge, type BadgeProps } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type {
    BelgianTaxCalculation,
    BelgianTaxProfile,
} from "@/lib/belgianTax";
import { resolveHistoricalBannerMode } from "./historicalBannerMode";
import type { HistoricalYearBannerMode } from "./HistoricalYearBanner";
import { usePercentFormatter } from "@/hooks/useCurrencyFormatter";

/** `live` = the year the profile is actually on; the rest mirror the banner modes. */
type FilingStatus = "live" | HistoricalYearBannerMode;

const STATUS_ICON: Record<FilingStatus, typeof History> = {
    live: Sparkles,
    estimate: History,
    snapshot: History,
    frozen: Snowflake,
    filed: Lock,
};

const STATUS_BADGE: Record<
    FilingStatus,
    { variant: BadgeProps["variant"]; className?: string }
> = {
    live: { variant: "default" },
    estimate: { variant: "muted" },
    snapshot: { variant: "secondary" },
    frozen: { variant: "outline", className: "text-info" },
    filed: { variant: "warning" },
};

interface TaxFilingMastheadProps {
    /** Profile for the viewed year — only its `region` is read. */
    profile: BelgianTaxProfile;
    /** Display calculation for the viewed year — only its two rates are read. */
    calculation: BelgianTaxCalculation;
}

export function TaxFilingMasthead({
    profile,
    calculation,
}: TaxFilingMastheadProps) {
    const formatPercent = usePercentFormatter();
    const { t } = useLanguage();
    const {
        liveYear,
        viewedYear,
        setViewedYear,
        isViewingHistorical,
        hasSnapshot,
        createSnapshotFromLive,
        isFiled,
        hasFrozenCalculation,
        filingReference,
    } = useBelgianTaxProfile((state) => ({
        liveYear: state.profile.taxYear,
        viewedYear: state.viewedYear,
        setViewedYear: state.setViewedYear,
        isViewingHistorical: state.isViewingHistorical,
        hasSnapshot: Object.prototype.hasOwnProperty.call(
            state.snapshots,
            state.viewedYear,
        ),
        createSnapshotFromLive: state.createSnapshotFromLive,
        isFiled: Boolean(state.snapshotMetas[state.viewedYear]?.filing),
        hasFrozenCalculation: Boolean(
            state.snapshotMetas[state.viewedYear]?.frozenCalculation,
        ),
        filingReference:
            state.snapshotMetas[state.viewedYear]?.filing?.reference,
    }));

    const historical = isViewingHistorical
        ? resolveHistoricalBannerMode({
              isFiled,
              hasFrozenCalculation,
              hasSnapshot,
              filingReference,
          })
        : undefined;

    const status: FilingStatus = historical?.mode ?? "live";
    const StatusIcon = STATUS_ICON[status];
    const statusBadge = STATUS_BADGE[status];

    return (
        <Card asChild className="overflow-hidden">
            <section aria-labelledby="tax-filing-year">
                <CardContent variant="headerless" className="space-y-5">
                    <div className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
                        {/* ── Identity: the year and its state ── */}
                        <div className="min-w-0 space-y-2">
                            <p className="eyebrow">
                                {t("tax.masthead.eyebrow")}
                            </p>
                            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                <h2
                                    id="tax-filing-year"
                                    className="type-large-title tabular-nums text-foreground"
                                >
                                    {viewedYear}
                                </h2>
                                <Badge
                                    variant={statusBadge.variant}
                                    className={cn("gap-1.5", statusBadge.className)}
                                >
                                    <StatusIcon
                                        className="h-3 w-3"
                                        aria-hidden="true"
                                    />
                                    <span className="sr-only">
                                        {t("tax.masthead.statusLabel")}:{" "}
                                    </span>
                                    {t(`tax.masthead.status.${status}`)}
                                </Badge>
                            </div>
                        </div>

                        {/* ── Figures: two qualifiers, then the single hero number ── */}
                        <dl className="flex flex-wrap items-end gap-x-8 gap-y-4">
                            <div className="min-w-0">
                                <dt className="type-caption text-label-tertiary">
                                    {t("tax.masthead.meta.region")}
                                </dt>
                                {/* Resolves the stored enum through the same
                                    `tax.profile.region.*.label` keys RegionStep uses, so it
                                    reads "Flanders (Vlaanderen)" rather than `flanders`. */}
                                <dd className="mt-1 type-title-3 text-foreground">
                                    {t(
                                        `tax.profile.region.${profile.region}.label`,
                                    )}
                                </dd>
                            </div>
                            <div>
                                <dt className="type-caption text-label-tertiary">
                                    {t("tax.masthead.meta.marginalRate")}
                                </dt>
                                <dd className="mt-1 type-title-3 tabular-nums text-foreground">
                                    {formatPercent(calculation.marginalRate, {
                                        digits: 0,
                                    })}
                                </dd>
                            </div>
                            <div className="border-border/60 sm:border-l sm:pl-8">
                                <dt className="type-caption text-label-tertiary">
                                    {t("tax.masthead.meta.effectiveBurden")}
                                </dt>
                                <dd className="mt-1 type-large-title tabular-nums text-primary">
                                    {formatPercent(calculation.effectiveRate, {
                                        digits: 1,
                                    })}
                                </dd>
                            </div>
                        </dl>
                    </div>

                    {/* ── Historical-year notice ── */}
                    {historical && (
                        <div className="flex flex-col gap-3 border-t border-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                            <p className="type-callout text-label-secondary">
                                <span className="type-headline text-foreground">
                                    {t(
                                        `tax.historical.banner.${historical.mode}Title`,
                                        { year: String(viewedYear) },
                                    )}
                                </span>{" "}
                                {t(
                                    `tax.historical.banner.${historical.mode}Desc`,
                                    { year: String(viewedYear) },
                                )}
                                {historical.mode === "filed" &&
                                    historical.filingReference && (
                                        <span className="ml-1 font-medium text-warning">
                                            (
                                            {t(
                                                "tax.historical.banner.filedReferencePrefix",
                                            )}
                                            : {historical.filingReference})
                                        </span>
                                    )}
                            </p>
                            <span className="flex shrink-0 items-center gap-2">
                                {historical.mode === "estimate" && (
                                    <Button
                                        size="sm"
                                        variant="outline"
                                        onClick={() =>
                                            createSnapshotFromLive(viewedYear)
                                        }
                                    >
                                        <Plus />
                                        {t("tax.historical.banner.createCta", {
                                            year: String(viewedYear),
                                        })}
                                    </Button>
                                )}
                                <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => setViewedYear(liveYear)}
                                >
                                    {t("tax.historical.banner.returnCta", {
                                        year: String(liveYear),
                                    })}
                                </Button>
                            </span>
                        </div>
                    )}
                </CardContent>
            </section>
        </Card>
    );
}
