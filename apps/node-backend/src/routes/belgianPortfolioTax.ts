import { Router } from "express";
import { z } from "zod";
import { parseInput } from "../lib/zodInput.ts";
import { getPortfolioTaxDashboard } from "../services/tax/portfolioDashboardService.ts";

const router = Router();
const schema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1900).max(2200))
    .optional(),
  currency: z
    .string()
    .regex(/^[A-Za-z]{3}$/)
    .transform((s) => s.toUpperCase())
    .default("EUR"),
});
router.get("/portfolio-dashboard", async (req, res) => {
  const { year, currency } = parseInput(schema, req.query);
  res.ok(await getPortfolioTaxDashboard(year, currency));
});
export default router;
