/**
 * Report routes.
 *
 * POST /api/reports/financial  — Puppeteer-rendered financial report.
 * POST /api/reports/portfolio  — Puppeteer-rendered portfolio report.
 * POST /api/reports/tax        — Puppeteer-rendered tax report.
 *
 * GET  /api/reports/financial  — Legacy PDFKit shim; kept for one release cycle.
 *
 * All POST bodies are validated with Zod. Theme tokens (HSL component strings)
 * are forwarded by the frontend so the PDF matches the active app theme.
 */

import { Router } from 'express';
import { z } from 'zod';
import { generateReport } from '../services/reports/index.js';
import { streamFinancialReport } from '../services/pdfReportService.js';
import { ValidationError } from '../middleware/errorHandler.js';

const router = Router();

/* ── Zod schemas ─────────────────────────────────────────────────────────── */

const hslToken = z.string().min(1);

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
}).default({});

const periodSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ytd') }),
  z.object({ kind: z.literal('rolling'), months: z.number().int().min(1).max(60) }),
  z.object({ kind: z.literal('custom'), from: z.string().min(1), to: z.string().min(1) }),
  z.object({ kind: z.literal('year'), year: z.number().int().min(2000).max(2100) }),
]).default({ kind: 'rolling', months: 12 });

const reportBodySchema = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/, 'currency must be a 3-letter ISO code').default('EUR'),
  period:   periodSchema,
  sections: z.array(z.string()).default([]),
  theme:    themeSchema,
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function parseReportBody(body) {
  const result = reportBodySchema.safeParse(body);
  if (!result.success) {
    const msg = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ValidationError(`Invalid report request: ${msg}`);
  }
  return result.data;
}

/* ── POST endpoints ──────────────────────────────────────────────────────── */

router.post('/financial', async (req, res) => {
  const { currency, period, sections, theme } = parseReportBody(req.body);
  await generateReport({ type: 'financial', currency, period, sections, theme, res });
});

router.post('/portfolio', async (req, res) => {
  const { currency, period, sections, theme } = parseReportBody(req.body);
  await generateReport({ type: 'portfolio', currency, period, sections, theme, res });
});

router.post('/tax', async (req, res) => {
  const { currency, period, sections, theme } = parseReportBody(req.body);
  await generateReport({ type: 'tax', currency, period, sections, theme, res });
});

/* ── Legacy GET shim ─────────────────────────────────────────────────────── */

router.get('/financial', async (req, res) => {
  const raw = req.query.currency ?? req.query.target_currency;
  const currency = raw && /^[A-Z]{3}$/.test(String(raw).toUpperCase().trim())
    ? String(raw).toUpperCase().trim()
    : 'EUR';
  await streamFinancialReport({ targetCurrency: currency, res });
});

export default router;
