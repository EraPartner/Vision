import { z } from "zod";

import { IdSchema } from "./common.ts";
import { InvestmentSchema } from "./portfolio.ts";

/*
 * Wire contracts for /api/portfolio/import reads that are not already parsed
 * by their client (the batch history and reconciliation reads keep their own
 * schemas in lib/api/portfolioImports.ts).
 */

const CountSchema = z.number().int().nonnegative();
/** A BIGSERIAL/BIGINT id: node-postgres returns it as a digit string. */
const BigintIdStringSchema = z.string().regex(/^[1-9]\d*$/);
/** A NUMERIC column left as node-postgres's decimal string. */
const PgNumericStringSchema = z.string().regex(/^-?\d+(\.\d+)?$/);

/**
 * A saved parser config (customParserConfigRepository.mapRow). The stored
 * config is re-checked on read by the backend's storedParserConfigSchema, so
 * only its object shape is checked here.
 */
export const SavedPortfolioParserConfigSchema = z.looseObject({
  id: IdSchema,
  name: z.string(),
  kind: z.string(),
  config: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  updated_at: z.string(),
});

/** `GET /api/portfolio/import/parsers` — `{items, total}`. */
export const SavedPortfolioParserConfigListSchema = z.looseObject({
  items: z.array(SavedPortfolioParserConfigSchema),
  total: CountSchema,
});

/**
 * One staged row of the review preview (portfolioImportBatchRepository
 * .getPreviewRows): the BIGSERIAL id and the NUMERIC columns arrive as
 * node-postgres strings, `tx_date` via to_char.
 */
export const PortfolioPreviewRowSchema = z.looseObject({
  id: BigintIdStringSchema,
  row_index: z.number().int().nonnegative(),
  status: z.string(),
  route: z.string().nullable(),
  tx_date: z.string().nullable(),
  type: z.string().nullable(),
  type_raw: z.string().nullable(),
  symbol_raw: z.string().nullable(),
  name_raw: z.string().nullable(),
  units: PgNumericStringSchema.nullable(),
  price_per_unit: PgNumericStringSchema.nullable(),
  amount: PgNumericStringSchema.nullable(),
  fees: PgNumericStringSchema.nullable(),
  taxes: PgNumericStringSchema.nullable(),
  currency: z.string().nullable(),
  fx_rate_to_eur: PgNumericStringSchema.nullable(),
  note: z.string().nullable(),
  match_source: z.string().nullable(),
  error_message: z.string().nullable(),
  user_override_investment_id: IdSchema.nullable(),
});

/** `GET /api/portfolio/import/batches/:id/preview`. */
export const PortfolioPreviewSchema = z.looseObject({
  batch_id: IdSchema,
  account_id: IdSchema.nullable(),
  account_name: z.string().nullable(),
  account_valid: z.boolean(),
  groups: z.array(
    z.looseObject({
      is_cash: z.boolean(),
      investment_id: IdSchema.nullable(),
      investment_name: z.string().nullable(),
      investment_symbol: z.string().nullable(),
      investment_asset_class: z.string().nullable(),
      raw_symbol: z.string().nullable(),
      raw_name: z.string().nullable(),
      row_count: CountSchema,
      rows: z.array(PortfolioPreviewRowSchema),
    }),
  ),
  // symbol/name_exact/unresolved/error are always present; any other
  // match_source value adds its own count.
  totals: z.record(z.string(), CountSchema).and(
    z.looseObject({
      symbol: CountSchema,
      name_exact: CountSchema,
      unresolved: CountSchema,
      error: CountSchema,
    }),
  ),
});

/**
 * `POST /api/portfolio/import/batches/:id/rows/:rowId/investment-override`:
 * `{row_id, investment_id, created: true, investment}` for "create new", or
 * `{row_id, user_override_investment_id}` (null clears) otherwise.
 */
export const PortfolioRowOverrideResultSchema = z.union([
  z.looseObject({
    row_id: IdSchema,
    investment_id: IdSchema,
    created: z.literal(true),
    investment: InvestmentSchema,
  }),
  z.looseObject({
    row_id: IdSchema,
    user_override_investment_id: IdSchema.nullable(),
  }),
]);

/** `POST /api/portfolio/import/batches/:id/rows/investment-override`. */
export const PortfolioRowsOverrideResultSchema = z.looseObject({
  investment_id: IdSchema,
  created: z.boolean(),
  resolved: CountSchema,
  investment: InvestmentSchema.optional(),
});

/** `POST /api/portfolio/import/batches/:id/commit`. */
export const PortfolioBatchCommitResultSchema = z.looseObject({
  batch_id: IdSchema,
  total: CountSchema,
  imported: CountSchema,
  duplicates: CountSchema,
  errors: CountSchema,
});

/** `DELETE /api/portfolio/import/batches/:id` — rollback, `{deleted, ...}`. */
export const PortfolioBatchRollbackResultSchema = z.looseObject({
  deleted: CountSchema,
});

/**
 * `POST /api/portfolio/import/csv/custom`: 201 with the committed counts, or
 * 202 `{batch_id, requires_review: true, match_source_counts, skipped}`.
 */
export const PortfolioImportResultSchema = z.union([
  z.looseObject({
    batch_id: IdSchema,
    total: CountSchema,
    skipped: CountSchema,
    imported: CountSchema,
    duplicates: CountSchema,
    errors: CountSchema,
  }),
  z.looseObject({
    batch_id: IdSchema,
    requires_review: z.literal(true),
    match_source_counts: z.record(z.string(), z.number()),
    skipped: CountSchema,
  }),
]);
