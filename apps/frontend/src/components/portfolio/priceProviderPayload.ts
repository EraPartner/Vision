/**
 * Maps the priceProvider* form fields onto the investment API payload —
 * trimmed, with empties dropped to `undefined` (omitted keys leave the stored
 * value untouched on PATCH). Shared by AddInvestmentDialog and
 * EditInvestmentDialog, which previously carried mirrored trim-blocks.
 * (Lives outside PriceProviderFields.tsx so that file only exports components,
 * keeping fast refresh intact.)
 */

import type { PriceProviderFormShape } from './PriceProviderFields';

export function priceProviderPayload(form: PriceProviderFormShape & { priceProviderUrl: string }) {
  return {
    price_provider: form.priceProvider,
    price_provider_id: form.priceProviderId.trim() || undefined,
    price_provider_url: form.priceProviderUrl.trim() || undefined,
    price_provider_latest_url: form.priceProviderLatestUrl.trim() || undefined,
    price_provider_latest_path: form.priceProviderLatestPath.trim() || undefined,
    price_provider_history_url: form.priceProviderHistoryUrl.trim() || undefined,
    price_provider_history_path: form.priceProviderHistoryPath.trim() || undefined,
    price_provider_history_ts_path: form.priceProviderHistoryTsPath.trim() || undefined,
    price_provider_history_price_path: form.priceProviderHistoryPricePath.trim() || undefined,
  };
}
