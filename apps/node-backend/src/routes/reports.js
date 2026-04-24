/**
 * Report routes.
 *
 * GET /api/reports/financial  — streams a PDFKit financial report.
 *   Query params:
 *     currency  (default: EUR)
 */

import { Router } from 'express';
import { streamFinancialReport } from '../services/pdfReportService.js';

const router = Router();

function getTargetCurrency(req) {
  const raw = req.query.currency ?? req.query.target_currency;
  if (raw == null || raw === '') return 'EUR';
  const value = String(raw).toUpperCase().trim();
  return /^[A-Z]{3}$/.test(value) ? value : 'EUR';
}

router.get('/financial', async (req, res) => {
  const targetCurrency = getTargetCurrency(req);
  await streamFinancialReport({ targetCurrency, res });
});

export default router;
