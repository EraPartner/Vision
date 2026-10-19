import { buildTaxOverview } from "@vision/shared-utils/belgian-tax/overview";
import settingsService from "../settingsService.ts";

/** Read-only hydration using the web provider's shared v1/v2 upgrade rules. */
export async function getTaxOverview(requestedYear?: number) {
  // One SELECT gives household, snapshots, metadata, and CAS baselines from the same read.
  const { settings, expected } = await settingsService.getAllWithBaselines();
  return buildTaxOverview(settings, expected, requestedYear);
}
