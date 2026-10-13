import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import { loadHouseholdSettings } from "@vision/shared-utils/belgian-tax/settings";
import { projectHouseholdToProfileV1 } from "@vision/shared-utils/belgian-tax/householdMigration";
import {
  DEFAULT_BELGIAN_TAX_PROFILE,
  hasMeaningfulBelgianTaxData,
} from "@vision/shared-utils/belgian-tax/profileDefaults";
import type { BelgianTaxProfile } from "@vision/shared-utils/belgian-tax/types";
import type { HouseholdTaxResult } from "@vision/shared-utils/belgian-tax/householdTypes";
import settingsService from "../settingsService.ts";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Read-only hydration using the web provider's shared v1/v2 upgrade rules. */
export async function getTaxOverview(requestedYear?: number) {
  // One SELECT gives household, snapshots, metadata, and CAS baselines from the same read.
  const { settings, expected } = await settingsService.getAllWithBaselines();
  const mergedProfile = {
    ...DEFAULT_BELGIAN_TAX_PROFILE,
    ...record(settings.belgian_tax_profile),
  } as BelgianTaxProfile;
  const loaded = loadHouseholdSettings({
    defaultsV1: DEFAULT_BELGIAN_TAX_PROFILE,
    profileV1: {
      ...mergedProfile,
      profileConfigured: hasMeaningfulBelgianTaxData(mergedProfile),
    },
    hasProfileV1: settings.belgian_tax_profile != null,
    snapshotsV1: settings.belgian_tax_profile_snapshots_v1,
    householdV2: settings.belgian_tax_household_v2,
    snapshotsV2: settings.belgian_tax_household_snapshots_v2,
  });
  let live = loaded.household;
  if (
    !live.profileConfigured &&
    hasMeaningfulBelgianTaxData(projectHouseholdToProfileV1(live))
  ) {
    live = { ...live, profileConfigured: true };
  }
  const year = requestedYear ?? live.taxYear;
  const household =
    year === live.taxYear
      ? live
      : (loaded.snapshots[year] ?? { ...live, taxYear: year });
  const snapshotMetas = record(settings.belgian_tax_profile_snapshot_meta_v1);
  const metadata = record(snapshotMetas[year]);
  const frozenCalculation = metadata.frozenCalculation;
  const frozenResult = metadata.frozenHouseholdResult;
  // A fully frozen filing must not run through a newer engine, even as an unused preview.
  let computed: HouseholdTaxResult | undefined;
  const currentResult = () => (computed ??= computeHouseholdTax(household));
  const calculation =
    frozenCalculation ?? toBelgianTaxCalculation(currentResult(), household);
  const result = frozenResult ?? currentResult();
  const keys = [
    "belgian_tax_household_v2",
    "belgian_tax_household_snapshots_v2",
    "belgian_tax_profile_snapshot_meta_v1",
  ];
  return {
    year,
    liveYear: live.taxYear,
    isHistorical: year !== live.taxYear,
    hasSnapshot: Object.hasOwn(loaded.snapshots, year),
    hasProfile: live.profileConfigured,
    household,
    liveHousehold: live,
    householdSnapshots: loaded.snapshots,
    snapshotMetas,
    metadata,
    calculation,
    result,
    calculationSource: frozenCalculation != null ? "frozen" : "computed",
    householdResultSource: frozenResult != null ? "frozen" : "computed",
    householdMigrationNeeded: loaded.writeHousehold,
    snapshotsMigrationNeeded: loaded.writeSnapshots,
    storedValueInvalid: loaded.storedValueInvalid,
    warnings: loaded.warnings.map(({ key, kind, issues }) => ({
      key,
      kind,
      issues,
    })),
    // Original values/baselines are retained, including absent vs JSON null and legacy JSON strings.
    records: keys.map((key) => ({
      key,
      value: settings[key] ?? null,
      expected: expected[key] ?? { exists: false },
    })),
  };
}
