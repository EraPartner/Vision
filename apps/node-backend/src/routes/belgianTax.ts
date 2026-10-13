import { Router } from "express";
import { z } from "zod";
import {
  computeHouseholdTax,
  toBelgianTaxCalculation,
} from "@vision/shared-utils/belgian-tax/household";
import type { BelgianTaxHouseholdV2 } from "@vision/shared-utils/belgian-tax/householdTypes";
import { parseInput } from "../lib/zodInput.ts";
import { belgianTaxHouseholdV2Schema } from "./belgianTaxSettingsSchemas.ts";

const router = Router();
const computationSchema = z.strictObject({
  household: belgianTaxHouseholdV2Schema,
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
