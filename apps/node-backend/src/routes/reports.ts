/**
 * Report routes.
 *
 * POST /api/reports/financial  — Puppeteer-rendered financial report.
 * POST /api/reports/portfolio  — Puppeteer-rendered portfolio report.
 * POST /api/reports/tax        — Puppeteer-rendered tax report.
 *
 * All POST bodies are validated with Zod. Theme tokens are forwarded by the
 * frontend so the PDF matches the active app theme; each is constrained to the
 * HSL-component shape ("H S% L%") because it is interpolated verbatim into a
 * `:root {}` block the renderer evaluates — see themeCss.js for the sink-side
 * guard and the CSS-injection rationale.
 */

import { Router } from "express";
import type { ExpressResponse } from "../types/express.ts";
import { z } from "zod";
import { generateReport } from "../services/reports/index.ts";
import { HSL_COMPONENT_RE } from "../services/reports/themeCss.ts";
import { parseInput } from "../lib/zodInput.ts";
import { belgianTaxHouseholdV2Schema } from "./belgianTaxSettingsSchemas.ts";

const router = Router();

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Theme tokens are NOT free strings: they land inside rendered CSS. Pin them to
// an HSL-component triple ("158 62% 32%") to prevent CSS injection / url()-SSRF.
const hslToken = z
  .string()
  .regex(
    HSL_COMPONENT_RE,
    'theme token must be an HSL component triple like "158 62% 32%"',
  );

const themeSchema = z
  .object({
    primary: hslToken.optional(),
    accent: hslToken.optional(),
    success: hslToken.optional(),
    expense: hslToken.optional(),
    surface: hslToken.optional(),
    text: hslToken.optional(),
    muted: hslToken.optional(),
    border: hslToken.optional(),
    chart1: hslToken.optional(),
    chart2: hslToken.optional(),
    chart3: hslToken.optional(),
    chart4: hslToken.optional(),
    chart5: hslToken.optional(),
    chart6: hslToken.optional(),
    chart7: hslToken.optional(),
    chart8: hslToken.optional(),
    mode: z.enum(["light", "dark"]).default("light"),
  })
  // An omitted theme renders light; every consumer also reads a missing mode as light.
  .default({ mode: "light" });

const periodSchema = z
  .discriminatedUnion("kind", [
    z.object({ kind: z.literal("ytd") }),
    z.object({
      kind: z.literal("rolling"),
      months: z.number().int().min(1).max(60),
    }),
    // Strict YYYY-MM-DD: from/to land in SQL date casts — malformed values were
    // a 500 (pg cast error) instead of a 400.
    z.object({
      kind: z.literal("custom"),
      from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "from must be YYYY-MM-DD"),
      to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "to must be YYYY-MM-DD"),
    }),
    z.object({
      kind: z.literal("year"),
      year: z.number().int().min(2000).max(2100),
    }),
  ])
  .default({ kind: "rolling", months: 12 });

const taxProfileSchema = z
  .object({
    filingStatus: z.string().optional(),
    region: z.string().optional(),
    taxYear: z.number().int().optional(),
  })
  .optional();

const precomputedPITSchema = z
  .object({
    taxableIncome: z.number().optional(),
    totalTax: z.number().optional(),
    brackets: z
      .array(
        z.object({
          label: z.string().optional(),
          rate: z.number().optional(),
          taxableIncome: z.number().optional(),
          taxAmount: z.number().optional(),
        }),
      )
      .optional(),
  })
  .optional();

// Per-partner household result from the frontend engine (ADR-200/201): the tax
// section renders a row per partner plus the household total when two partners
// are assessed. Amounts only; the backend computes no tax.
const reportPartnerId = z.enum(["A", "B"]);
const precomputedHouseholdSchema = z
  .object({
    assessmentMode: z.enum(["single", "separate", "joint"]),
    legalBasis: z.string().max(200).optional(),
    quotient: z
      .object({
        applied: z.boolean(),
        transfer: z.number(),
        fromPartnerId: reportPartnerId.optional(),
        toPartnerId: reportPartnerId.optional(),
        benefit: z.number(),
      })
      .optional(),
    partners: z
      .array(
        z.object({
          partnerId: reportPartnerId,
          grossIncome: z.number(),
          taxableIncome: z.number(),
          totalPIT: z.number(),
        }),
      )
      .min(1)
      .max(2)
      .refine(
        (partners) =>
          new Set(partners.map((p) => p.partnerId)).size === partners.length,
        { message: "partner ids must be unique" },
      ),
  })
  .optional();

const int4Id = z.number().int().positive().max(2147483647);

const reportBodySchema = z.object({
  currency: z
    .string()
    .regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code")
    .default("EUR"),
  period: periodSchema,
  sections: z.array(z.string()).default([]),
  theme: themeSchema,
  excludedCategoryIds: z.array(int4Id).default([]),
  excludedRecipientIds: z.array(int4Id).default([]),
  taxProfile: taxProfileSchema,
  precomputedPIT: precomputedPITSchema,
  // The year's household (same schema as the belgian_tax_household_v2 setting).
  household: belgianTaxHouseholdV2Schema.optional(),
  precomputedHousehold: precomputedHouseholdSchema,
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function parseReportBody(body: unknown) {
  return parseInput(reportBodySchema, body, {
    prefix: "Invalid report request",
  });
}

export { parseReportBody as __parseReportBody };

/**
 * Generate and send one PDF response while keeping Express concerns in the
 * route layer.
 */
async function sendReport(
  res: ExpressResponse,
  options: Parameters<typeof generateReport>[0],
) {
  const controller = new AbortController();
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once?.("close", cancel);
  try {
    const { pdf, filename } = await generateReport({
      ...options,
      signal: controller.signal,
    });
    if (controller.signal.aborted || res.writableEnded) return;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Length", pdf.length);
    res.end(pdf);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    res.removeListener?.("close", cancel);
  }
}

/* ── POST endpoints ──────────────────────────────────────────────────────── */

router.post("/financial", async (req, res) => {
  const {
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
  } = parseReportBody(req.body);
  await sendReport(res, {
    type: "financial",
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
  });
});

router.post("/portfolio", async (req, res) => {
  const {
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
  } = parseReportBody(req.body);
  await sendReport(res, {
    type: "portfolio",
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
  });
});

router.post("/tax", async (req, res) => {
  const {
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
    taxProfile,
    precomputedPIT,
    household,
    precomputedHousehold,
  } = parseReportBody(req.body);
  await sendReport(res, {
    type: "tax",
    currency,
    period,
    sections,
    theme,
    excludedCategoryIds,
    excludedRecipientIds,
    taxProfile,
    precomputedPIT,
    household,
    precomputedHousehold,
  });
});

export default router;
