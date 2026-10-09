/**
 * Query-string helpers shared by /api/info sub-routers.
 */

import { z } from "zod";
import { todayAppDateString } from "../../lib/timezone.ts";
import { bareMessages } from "../../lib/zodInput.ts";
import { singleQueryValue } from "../_inputBridges.ts";

function normalizeTargetCurrency(raw: unknown): string {
  if (raw == null || raw === "") return "EUR";

  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : "EUR";
}

// Still read directly by routes/aggregations.ts.
export function getTargetCurrency(req: {
  query: Record<string, unknown>;
}): string {
  return normalizeTargetCurrency(
    req.query.currency ?? req.query.target_currency,
  );
}

export function getMonthParam(raw: unknown): string | undefined {
  if (raw == null || raw === "") return undefined;
  const value = String(raw).trim();
  if (/^\d{4}-\d{2}$/.test(value)) return value;
  if (/^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 7);
  return undefined;
}

/**
 * `currency` (or its `target_currency` alias) → the target currency. A
 * malformed code still falls back to EUR, as before; a repeated or bracketed
 * key is a 400.
 */
export const targetCurrencyQuerySchema = bareMessages(
  z.object({
    currency: singleQueryValue("currency"),
    target_currency: singleQueryValue("target_currency"),
  }),
).transform((query) => ({
  targetCurrency: normalizeTargetCurrency(
    query.currency ?? query.target_currency,
  ),
}));

/**
 * A `YYYY-MM` month (a full date is truncated to its month). Malformed values
 * are ignored, as before; a repeated or bracketed key is a 400.
 */
export function monthQueryField(name: string) {
  return singleQueryValue(name).transform(getMonthParam);
}

// Kept as the import point for the /api/info sub-routers; the implementation
// is the shared APP_TIMEZONE "today" (UTC read here was yesterday until
// 01:00/02:00 local in UTC+ zones).
export function getCurrentDateString(): string {
  return todayAppDateString();
}
