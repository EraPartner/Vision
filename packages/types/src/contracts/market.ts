import { z } from "zod";

import { ASSET_CLASSES } from "../assetClasses.ts";
import { IdSchema } from "./common.ts";

/*
 * Wire contracts for /api/market (Yahoo-backed lookups) and /api/watchlist.
 *
 * The market bodies are mapped from Yahoo responses fetched with validation
 * off (marketLookupService, NO_VALIDATE), so a provider field can be missing
 * or null. Only the container shape and the fields the service always sets
 * are required; every provider-sourced leaf is type-checked when present.
 */

const CountSchema = z.number().int().nonnegative();
/** A provider-sourced numeric leaf: absent, null, or a number. */
const ProviderNumber = z.number().nullable().optional();
const ProviderString = z.string().nullable().optional();

/** marketLookupService.mapQuoteCore plus the `full` fundamentals fields. */
export const MarketQuoteSchema = z.looseObject({
  symbol: z.string(),
  name: ProviderString,
  price: ProviderNumber,
  change: ProviderNumber,
  changePercent: ProviderNumber,
  currency: z.string(),
  exchange: ProviderString,
  type: ProviderString,
  open: ProviderNumber,
  dayHigh: ProviderNumber,
  dayLow: ProviderNumber,
  prevClose: ProviderNumber,
  volume: ProviderNumber,
  avgVolume: ProviderNumber,
  high52w: ProviderNumber,
  low52w: ProviderNumber,
  analystConsensus: z
    .looseObject({
      strongBuy: z.number(),
      buy: z.number(),
      hold: z.number(),
      sell: z.number(),
      strongSell: z.number(),
    })
    .nullable()
    .optional(),
  recentAnalystActions: z.array(z.looseObject({})).optional(),
});

/** `GET /api/market/quote` — `{items, total}`; failed symbols are dropped. */
export const MarketQuoteListSchema = z.looseObject({
  items: z.array(MarketQuoteSchema),
  total: CountSchema,
});

/**
 * `GET /api/market/chart`. Points with a null close are filtered out by the
 * service. `symbol`/`currency` come from Yahoo's `meta` and are absent when
 * Yahoo answered nothing.
 */
export const MarketChartSchema = z.looseObject({
  symbol: ProviderString,
  currency: ProviderString,
  items: z.array(
    z.looseObject({
      time: z.number(),
      close: z.number(),
      high: ProviderNumber,
      low: ProviderNumber,
      volume: ProviderNumber,
    }),
  ),
  total: CountSchema,
});

/** `GET /api/market/search` — `{items}` (no `total`); rows without a symbol are dropped. */
export const MarketSearchSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      symbol: z.string(),
      name: z.string(),
      type: z.string(),
      exchange: z.string(),
    }),
  ),
});

/** `GET /api/market/news` — `{items, total}`, deduplicated by title. */
export const MarketNewsListSchema = z.looseObject({
  items: z.array(
    z.looseObject({
      title: ProviderString,
      link: ProviderString,
      publisher: ProviderString,
      publishedAt: z.number().nullable(),
      thumbnail: z.string().nullable(),
      relatedSymbols: z.array(z.string()),
    }),
  ),
  total: CountSchema,
});

/**
 * One `watchlist` row after watchlistRepository.mapWatchlistRow: the NUMERIC
 * `target_price` and nullable `added_price` are JSON numbers.
 */
export const WatchlistItemSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  symbol: z.string().nullable(),
  asset_class: z.enum(ASSET_CLASSES),
  target_price: z.number(),
  added_price: z.number().nullable(),
  currency: z.string(),
  notes: z.string().nullable(),
  price_provider_id: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/watchlist` — always paginated (no `links`). */
export const WatchlistListSchema = z.looseObject({
  items: z.array(WatchlistItemSchema),
  total: CountSchema,
  limit: z.number().int().positive(),
  offset: CountSchema,
});
