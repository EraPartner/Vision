/**
 * Investment routes — thin router.
 * All business logic lives in services/investmentService.js.
 */

import { Router } from "express";
import { validateIdParam, validateIntParam } from "../middleware/validation.js";
import { rateLimiter } from "../middleware/rateLimiter.js";
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
} from "../services/investmentService.js";
import {
  getPortfolioExposure,
  upsertPortfolioExposureBundle,
} from "../services/portfolio/portfolioExposureService.js";
import { ValidationError } from "../middleware/errorHandler.js";

const router = Router();

// Investments
router.get("/", listInvestments);
router.post("/", createInvestment);
router.get("/providers", listProviders);
router.post("/refresh-prices", refreshPrices);
router.get("/transactions", getBulkTransactions);
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
  const currency = String(req.query.currency || "EUR").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency))
    throw new ValidationError("currency must be an ISO 4217 code");
  res.ok(await getPortfolioExposure(currency));
});
router.put("/exposure/sources", async (req, res) => {
  try {
    res.ok(await upsertPortfolioExposureBundle(req.body));
  } catch (error) {
    if (error.code !== "INVALID_PORTFOLIO_EXPOSURE_SOURCE") throw error;
    throw new ValidationError("The exposure source bundle is invalid", {
      code: error.code,
      issues: error.issues,
    });
  }
});

// Investments — by ID (validateIdParam must come before the handler)
router.get("/:id/price-history", validateIdParam, getPriceHistory);
router.get("/:id/transactions", validateIdParam, listTransactions);
router.post("/:id/transactions", validateIdParam, createTransaction);
router.get("/:id/summary", validateIdParam, getInvestmentSummary);
router.get("/:id", validateIdParam, getInvestment);
router.patch("/:id", validateIdParam, updateInvestment);
router.delete("/:id", validateIdParam, deleteInvestment);

// Portfolio transactions (no investment ID in path). `:txnId` is not `:id`, so
// the fixed validateIdParam cannot cover it — these were the only two routes in
// the file with no id guard at all, and DELETE /transactions/12abc therefore
// returned 204 having hard-deleted transaction 12.
router.delete(
  "/transactions/:txnId",
  validateIntParam("txnId"),
  deleteTransaction,
);
router.patch(
  "/transactions/:txnId",
  validateIntParam("txnId"),
  updateTransaction,
);

export default router;
