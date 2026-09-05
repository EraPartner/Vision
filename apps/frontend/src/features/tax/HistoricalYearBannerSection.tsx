import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { HistoricalYearBanner } from "@/features/tax/HistoricalYearBanner";
import { resolveHistoricalBannerMode } from "@/features/tax/historicalBannerMode";

/**
 * Self-contained historical-year banner used by both tax pages: resolves the
 * banner mode (filed / snapshot / estimate) for the viewed year and renders
 * nothing when the live year is being viewed.
 */
export function HistoricalYearBannerSection() {
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

    if (!isViewingHistorical) return null;

    const banner = resolveHistoricalBannerMode({
        isFiled,
        hasFrozenCalculation,
        hasSnapshot,
        filingReference,
    });
    return (
        <HistoricalYearBanner
            mode={banner.mode}
            viewedYear={viewedYear}
            currentYear={liveYear}
            onReturnToCurrent={() => setViewedYear(liveYear)}
            onCreateSnapshot={
                banner.mode === "estimate"
                    ? () => createSnapshotFromLive(viewedYear)
                    : undefined
            }
            filingReference={banner.filingReference}
        />
    );
}
