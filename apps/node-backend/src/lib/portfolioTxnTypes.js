/**
 * Canonical portfolio transaction types.
 *
 * The value list is single-sourced in @vision/types/portfolioTxnTypes (shared
 * with the frontend type unions); this module derives the Set consumed by the
 * import pipeline's type normalizer (services/portfolioImportPipeline/
 * portfolioTypeNormalizer.js), the import routes' Zod schema, and repository
 * payload validation (services/portfolio/portfolioTransactionRules.js) — a plain
 * constant, so it lives in lib/ where both layers may import it.
 */
import { PORTFOLIO_TXN_TYPES } from "@vision/types/portfolioTxnTypes";

// Widened to Set<string>: callers probe raw, untrusted values with .has().
export const VALID_PORTFOLIO_TXN_TYPES = new Set(
  /** @type {readonly string[]} */ (PORTFOLIO_TXN_TYPES),
);
