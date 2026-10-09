/**
 * Investment routes — thin router.
 * All business logic lives in services/investmentService.js.
 */

import { Router } from "express";
import { z } from "zod";
import { rateLimiter } from "../middleware/rateLimiter.ts";
import {
  listInvestments,
  createInvestment,
  listProviders,
  refreshPrices,
  getBulkTransactions,
  getPriceHistory,
  getInvestment,
  updateInvestment,
  deleteInvestment,
  listTransactions,
  createTransaction,
  deleteTransaction,
  updateTransaction,
  getInvestmentSummary,
  bulkRetagTransactions,
} from "../services/investmentService.ts";
import {
  getPortfolioExposure,
  upsertPortfolioExposureBundle,
} from "../services/portfolio/portfolioExposureService.ts";
import { ValidationError } from "../middleware/errorHandler.ts";
import { parseInput } from "../lib/zodInput.ts";
import type {
  ExpressNextFunction,
  ExpressRequest,
  ExpressResponse,
} from "../types/express.ts";
import {
  booleanQuery,
  idParams,
  idSchema,
  optionalValue,
  pageFields,
  singleQueryString,
} from "./_requestSchemas.ts";

const router = Router();

// ── Request schemas ──────────────────────────────────────────────────────────
//
// The handlers live in services/investmentService.ts, which validates bodies
// with zod and re-reads params/query at its point of use. These schemas gate
// params and query at the route boundary with the same accept sets; the
// lenient knobs (pagination, flags, time bounds) keep their fallbacks.

const txnParams = z.object({ txnId: idSchema() });

const listQuery = z.object({
  ...pageFields,
  asset_class: singleQueryString,
  active: booleanQuery(true),
});

// investment_ids stays with the service, which owns its required/empty
// messages and accepts the comma-joined and repeated forms.
const bulkTransactionsQuery = z.object({
  ...pageFields,
  investment_ids: optionalValue,
  type: singleQueryString,
  per_investment_limit: optionalValue,
});

// Unparseable from_ms/to_ms mean "no bound" in fetchHistoricalPrices.
const priceHistoryQuery = z.object({
  from_ms: optionalValue,
  to_ms: optionalValue,
  db_only: booleanQuery(true),
});

const transactionsQuery = z.object({
  ...pageFields,
  type: singleQueryString,
});

const exposureQuery = z.object({
  currency: optionalValue
    .transform((raw) => String(raw || "EUR").toUpperCase())
    .pipe(z.string().regex(/^[A-Z]{3}$/, "must be an ISO 4217 code")),
});

/** Middleware: parse params/query before handing over to a service handler. */
function parseRequest(schemas: { params?: z.ZodType; query?: z.ZodType }) {
  return (
    req: ExpressRequest,
    _res: ExpressResponse,
    next: ExpressNextFunction,
  ) => {
    if (schemas.params) parseInput(schemas.params, req.params);
    if (schemas.query) parseInput(schemas.query, req.query);
    next();
  };
}

const withId = parseRequest({ params: idParams });
const withTxnId = parseRequest({ params: txnParams });

interface ExposureSourceError extends Error {
  code: "INVALID_PORTFOLIO_EXPOSURE_SOURCE";
  issues?: unknown;
}

function isExposureSourceError(error: unknown): error is ExposureSourceError {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "INVALID_PORTFOLIO_EXPOSURE_SOURCE"
  );
}

// Investments
router.get("/", parseRequest({ query: listQuery }), listInvestments);
router.post("/", createInvestment);
router.get("/providers", listProviders);
router.post("/refresh-prices", refreshPrices);
router.get(
  "/transactions",
  parseRequest({ query: bulkTransactionsQuery }),
  getBulkTransactions,
);
router.put(
  "/transactions/broker",
  rateLimiter({
    windowMs: 60_000,
    maxRequests: 30,
    keyPrefix: "portfolio-broker-retag",
  }),
  bulkRetagTransactions,
);

router.get("/exposure", async (req, res) => {
  const { currency } = parseInput(exposureQuery, req.query);
  res.ok(await getPortfolioExposure(currency));
});
router.put("/exposure/sources", async (req, res) => {
  try {
    res.ok(await upsertPortfolioExposureBundle(req.body));
  } catch (error) {
    if (!isExposureSourceError(error)) throw error;
    throw new ValidationError("The exposure source bundle is invalid", {
      code: error.code,
      details: { issues: error.issues },
    });
  }
});

// Investments — by ID (the params guard must come before the handler)
router.get(
  "/:id/price-history",
  parseRequest({ params: idParams, query: priceHistoryQuery }),
  getPriceHistory,
);
router.get(
  "/:id/transactions",
  parseRequest({ params: idParams, query: transactionsQuery }),
  listTransactions,
);
router.post("/:id/transactions", withId, createTransaction);
router.get("/:id/summary", withId, getInvestmentSummary);
router.get("/:id", withId, getInvestment);
router.patch("/:id", withId, updateInvestment);
router.delete("/:id", withId, deleteInvestment);

// Portfolio transactions (no investment ID in path). `:txnId` is not `:id`:
// these were once the only two routes in the file with no id guard at all, and
// DELETE /transactions/12abc returned 204 having hard-deleted transaction 12.
router.delete("/transactions/:txnId", withTxnId, deleteTransaction);
router.patch("/transactions/:txnId", withTxnId, updateTransaction);

export default router;
