import { useQuery } from '@tanstack/react-query';
import {
  getSupportedPriceProviders,
  type SupportedPriceProvider,
} from '@/lib/api/portfolio';
import { portfolioKeys } from '@/lib/queryKeys';
import type { PriceProvider } from '@/types/api';
import type { TranslationKey } from "@/locales/keys";

type TranslateFn = (key: TranslationKey) => string;

export interface PriceProviderOption {
  key: PriceProvider;
  name: string;
  hint: string;
}

// The fallback keeps the form usable while the local catalog request is still
// loading or unavailable. Once the request succeeds, membership and ordering
// come exclusively from the backend catalog.
const FALLBACK_CATALOG: SupportedPriceProvider[] = [
  { key: 'manual', name: 'Manual', description: 'Set price manually' },
  { key: 'binance', name: 'Binance', description: 'Free crypto prices' },
  { key: 'yahoo', name: 'Yahoo Finance', description: 'Stocks, ETFs & metals' },
  { key: 'custom', name: 'Custom JSON', description: 'Configurable JSON endpoint' },
  { key: 'kinesis', name: 'Kinesis', description: 'Precious metals & commodities' },
];

const HINT_KEYS: Record<string, TranslationKey> = {
  manual: 'addInv.provider.hint.manual',
  binance: 'addInv.provider.hint.binance',
  yahoo: 'addInv.provider.hint.yahoo',
  custom: 'addInv.provider.hint.custom',
  kinesis: 'addInv.provider.hint.kinesis',
};

function toOption(provider: SupportedPriceProvider, t: TranslateFn): PriceProviderOption {
  const hintKey = HINT_KEYS[provider.key];
  return {
    // The generated PriceProvider union changes with the backend/OpenAPI enum.
    // The cast also lets a newer local backend expose a freshly-added provider
    // before the desktop shell has regenerated its compile-time union.
    key: provider.key as PriceProvider,
    name: provider.key === 'manual' ? t('addInv.provider.manual') : provider.name,
    hint: hintKey ? t(hintKey) : provider.description,
  };
}

export function usePriceProviderCatalog(t: TranslateFn): PriceProviderOption[] {
  const { data } = useQuery({
    queryKey: portfolioKeys.providers,
    queryFn: getSupportedPriceProviders,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const catalog = (data != null && data.length > 0) ? data : FALLBACK_CATALOG;
  return catalog.map((provider) => toOption(provider, t));
}
