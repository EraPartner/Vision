import { Router } from "express";
import dashboardRouter from "./belgianTaxDashboard.ts";
import { z } from "zod";
import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import type { BelgianTaxHouseholdV2 } from "@vision/shared-utils/belgian-tax/householdTypes";
import { parseInput } from "../lib/zodInput.ts";
import { belgianTaxHouseholdV2Schema } from "./belgianTaxSettingsSchemas.ts";
import { getTaxOverview } from "../services/tax/overviewService.ts";

const router = Router();
router.use(dashboardRouter);
const computationSchema = z.strictObject({
  household: belgianTaxHouseholdV2Schema,
});

const overviewQuerySchema = z.object({
  year: z
    .string()
    .regex(/^\d{4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1900).max(2200))
    .optional(),
});

router.get("/overview", async (req, res) => {
  const { year } = parseInput(overviewQuerySchema, req.query);
  res.ok(await getTaxOverview(year));
});

// Stateless: previewing an unsaved household never alters settings or frozen filing records.
router.post("/compute", (req, res) => {
  const parsed = parseInput(computationSchema, req.body);
  // JSON cannot contain explicit undefined; the validated optional fields are absent.
  const household = parsed.household as BelgianTaxHouseholdV2;
  const result = computeHouseholdTax(household);
  res.ok({ result, calculation: toBelgianTaxCalculation(result, household) });
});

export default router;
