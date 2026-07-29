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

import { Router } from 'express';
import { z } from 'zod';
import { generateReport } from '../services/reports/index.js';
import { HSL_COMPONENT_RE } from '../services/reports/themeCss.js';
import { ValidationError } from '../middleware/errorHandler.js';

/**
 * @typedef {import('../types/express.js').ExpressRequest} ExpressRequest
 * @typedef {import('../types/express.js').ExpressResponse} ExpressResponse
 */

const router = Router();

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

// Theme tokens are NOT free strings: they land inside rendered CSS. Pin them to
// an HSL-component triple ("158 62% 32%") to prevent CSS injection / url()-SSRF.
const hslToken = z
  .string()
  .regex(HSL_COMPONENT_RE, 'theme token must be an HSL component triple like "158 62% 32%"');

const themeSchema = z.object({
  primary:  hslToken.optional(),
  accent:   hslToken.optional(),
  success:  hslToken.optional(),
  expense:  hslToken.optional(),
  surface:  hslToken.optional(),
  text:     hslToken.optional(),
  muted:    hslToken.optional(),
  border:   hslToken.optional(),
  chart1:   hslToken.optional(),
  chart2:   hslToken.optional(),
  chart3:   hslToken.optional(),
  chart4:   hslToken.optional(),
  chart5:   hslToken.optional(),
  chart6:   hslToken.optional(),
  chart7:   hslToken.optional(),
  chart8:   hslToken.optional(),
  mode:     z.enum(['light', 'dark']).default('light'),
}).default(/** @type {any} */ ({}));

const periodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ytd') }),
  z.object({ kind: z.literal('rolling'), months: z.number().int().min(1).max(60) }),
  // Strict YYYY-MM-DD: from/to land in SQL date casts — malformed values were
  // a 500 (pg cast error) instead of a 400.
  z.object({
    kind: z.literal('custom'),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'from must be YYYY-MM-DD'),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'to must be YYYY-MM-DD'),
  }),
  z.object({ kind: z.literal('year'), year: z.number().int().min(2000).max(2100) }),
]).default({ kind: 'rolling', months: 12 });

const taxProfileSchema = z.object({
  filingStatus:  z.string().optional(),
  region:        z.string().optional(),
  taxYear:       z.number().int().optional(),
}).optional();

const precomputedPITSchema = z.object({
  taxableIncome: z.number().optional(),
  totalTax:      z.number().optional(),
  brackets:      z.array(z.object({
    label:         z.string().optional(),
    rate:          z.number().optional(),
    taxableIncome: z.number().optional(),
    taxAmount:     z.number().optional(),
  })).optional(),
}).optional();

const reportBodySchema = z.object({
  currency:             z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code').default('EUR'),
  period:               periodSchema,
  sections:             z.array(z.string()).default([]),
  theme:                themeSchema,
  excludedCategoryIds:  z.array(z.number().int().positive()).default([]),
  excludedRecipientIds: z.array(z.number().int().positive()).default([]),
  taxProfile:           taxProfileSchema,
  precomputedPIT:       precomputedPITSchema,
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** @param {unknown} body */
function parseReportBody(body) {
  const result = reportBodySchema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ValidationError(`Invalid report request: ${msg}`);
  }
  return result.data;
}

/* ── POST endpoints ──────────────────────────────────────────────────────── */

router.post('/financial', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { currency, period, sections, theme, excludedCategoryIds, excludedRecipientIds } = parseReportBody(req.body);
  await generateReport({ type: 'financial', currency, period, sections, theme, res, excludedCategoryIds, excludedRecipientIds });
});

router.post('/portfolio', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { currency, period, sections, theme, excludedCategoryIds, excludedRecipientIds } = parseReportBody(req.body);
  await generateReport({ type: 'portfolio', currency, period, sections, theme, res, excludedCategoryIds, excludedRecipientIds });
});

router.post('/tax', /** @param {ExpressRequest} req @param {ExpressResponse} res */ async (req, res) => {
  const { currency, period, sections, theme, excludedCategoryIds, excludedRecipientIds, taxProfile, precomputedPIT } = parseReportBody(req.body);
  await generateReport({ type: 'tax', currency, period, sections, theme, res, excludedCategoryIds, excludedRecipientIds, taxProfile, precomputedPIT });
});


export default router;
