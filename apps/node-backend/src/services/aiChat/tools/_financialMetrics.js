import { settingsRepository } from "../../../repositories/settingsRepository.js";
import { getPortfolioSummary } from "../../portfolio/portfolioSummaryService.js";
import { memoizeAsync } from "../toolCache.js";

const ISO_CURRENCY = /^[A-Z]{3}$/;

/**
 * Resolve the same display currency used by the shipped financial screens.
 * Invalid or missing persisted settings recover to EUR, matching the frontend.
 * @param {Map<string, Promise<any>>|undefined} cache
 */
export async function getAiDisplayCurrency(cache) {
  const settings = await memoizeAsync(cache, "settings:app_settings", () =>
    settingsRepository.get("app_settings"),
  );
  const currency = String(settings?.defaultCurrency || "EUR").toUpperCase();
  return ISO_CURRENCY.test(currency) ? currency : "EUR";
}

/**
 * Request-scoped canonical portfolio summary. Several tools can run during one
 * chat turn; sharing this promise keeps every answer on the same snapshot.
 * @param {Map<string, Promise<any>>|undefined} cache
 * @param {{ throughDate?: string, activeInvestmentsOnly?: boolean }} [options]
 */
export async function loadCanonicalPortfolioSummary(
  cache,
  { throughDate, activeInvestmentsOnly = true } = {},
) {
  const currency = await getAiDisplayCurrency(cache);
  const key = `portfolio-summary:${currency}:${throughDate ?? "current"}:${activeInvestmentsOnly ? "active" : "all"}`;
  return memoizeAsync(cache, key, () =>
    getPortfolioSummary(currency, { throughDate, activeInvestmentsOnly }),
  );
}
