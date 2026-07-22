import { useBelgianTaxProfile } from "@/contexts/BelgianTaxProfileContext";
import { HistoricalYearBanner } from "@/components/tax/HistoricalYearBanner";
import { resolveHistoricalBannerMode } from "@/components/tax/historicalBannerMode";

/**
 * Self-contained historical-year banner used by both tax pages: resolves the
 * banner mode (filed / snapshot / estimate) for the viewed year and renders
 * nothing when the live year is being viewed.
 */
export function HistoricalYearBannerSection() {
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

  if (!isViewingHistorical) return null;

  const banner = resolveHistoricalBannerMode({
    isFiled: isYearFiled(viewedYear),
    hasFrozenCalculation: getFrozenCalculation(viewedYear) != null,
    hasSnapshot: snapshotExistsForYear(viewedYear),
    filingReference: metaForYear(viewedYear)?.filing?.reference,
  });
  return (
    <HistoricalYearBanner
      mode={banner.mode}
      viewedYear={viewedYear}
      currentYear={liveProfile.taxYear}
      onReturnToCurrent={() => setViewedYear(liveProfile.taxYear)}
      onCreateSnapshot={
        banner.mode === 'estimate'
          ? () => createSnapshotFromLive(viewedYear)
          : undefined
      }
      filingReference={banner.filingReference}
    />
  );
}
