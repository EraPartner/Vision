import {
  settingField,
  settingsRepository,
} from "../../../repositories/settingsRepository.ts";
import { getPortfolioSummary } from "../../portfolio/portfolioSummaryService.ts";
import { memoizeAsync } from "../toolCache.ts";
import type { ToolCache } from "../toolCache.ts";

const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * Resolve the same display currency used by the shipped financial screens.
 * Invalid or missing persisted settings recover to EUR, matching the frontend.
 */
export async function getAiDisplayCurrency(
  cache: ToolCache | undefined,
): Promise<string> {
  const settings = await memoizeAsync(cache, "settings:app_settings", () =>
    settingsRepository.get("app_settings"),
  );
  const currency = String(
    settingField(settings, "defaultCurrency") || "EUR",
  ).toUpperCase();
  return ISO_CURRENCY.test(currency) ? currency : "EUR";
}

/**
 * Request-scoped canonical portfolio summary. Several tools can run during one
 * chat turn; sharing this promise keeps every answer on the same snapshot.
 */
export async function loadCanonicalPortfolioSummary(
  cache: ToolCache | undefined,
  {
    throughDate,
    activeInvestmentsOnly = true,
  }: { throughDate?: string; activeInvestmentsOnly?: boolean } = {},
) {
  const currency = await getAiDisplayCurrency(cache);
  const key = `portfolio-summary:${currency}:${throughDate ?? "current"}:${activeInvestmentsOnly ? "active" : "all"}`;
  return memoizeAsync(cache, key, () =>
    getPortfolioSummary(currency, { throughDate, activeInvestmentsOnly }),
  );
}
