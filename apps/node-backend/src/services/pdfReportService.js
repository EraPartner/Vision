/**
 * PDF Report Service — PDFKit-based financial report generator.
 *
 * Generates a self-contained PDF with:
 *   - Summary cards (income, spending, net, transactions)
 *   - Monthly income vs spending table
 *   - Top 10 spending categories
 *
 * @param {object} opts
 * @param {string} opts.targetCurrency
 * @param {import('pdfkit')} PDFDocument  Injected for testability; defaults to lazy require.
 */

import { computeMonthlySummary } from './calculations/aggregation/monthly.js';
import { computeCategoryBreakdown } from './calculations/aggregation/category.js';

const COLORS = {
  primary: '#4f46e5',
  income: '#16a34a',
  spending: '#dc2626',
  net: '#2563eb',
  heading: '#111827',
  subheading: '#374151',
  muted: '#6b7280',
  border: '#e5e7eb',
  rowAlt: '#f9fafb',
};

const MARGIN = 50;
const PAGE_WIDTH = 595; // A4
const COL_MONTH = MARGIN;
const COL_INCOME = MARGIN + 180;
const COL_SPENDING = MARGIN + 310;
const COL_NET = MARGIN + 430;

function formatMoney(amount, currency) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatPeriod(periodStr) {
  // periodStr = "YYYY-MM"
  const [year, month] = periodStr.split('-');
  const date = new Date(Number(year), Number(month) - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

/**
 * Draw a horizontal rule.
 */
function drawRule(doc, y, color = COLORS.border, width = PAGE_WIDTH - MARGIN * 2) {
  doc
    .moveTo(MARGIN, y)
    .lineTo(MARGIN + width, y)
    .strokeColor(color)
    .lineWidth(0.5)
    .stroke();
}

/**
 * Draw a summary stat box. Returns new x position.
 */
function drawStatBox(doc, x, y, label, value, color, boxWidth = 110) {
  doc
    .rect(x, y, boxWidth, 56)
    .fillColor(color + '18') // ~10% opacity hex
    .fill();

  doc
    .fontSize(8)
    .fillColor(COLORS.muted)
    .text(label.toUpperCase(), x + 8, y + 10, { width: boxWidth - 16 });

  doc
    .fontSize(13)
    .fillColor(color)
    .font('Helvetica-Bold')
    .text(value, x + 8, y + 24, { width: boxWidth - 16 });

  doc.font('Helvetica');
  return x + boxWidth + 8;
}

/**
 * Generate a financial PDF report and pipe it into the response stream.
 *
 * @param {object} opts
 * @param {string} opts.targetCurrency
 * @param {import('express').Response} opts.res
 */
export async function streamFinancialReport({ targetCurrency, res }) {
  const [monthlySummaryResult, categoryResult] = await Promise.all([
    computeMonthlySummary({ targetCurrency }),
    computeCategoryBreakdown({ targetCurrency }),
  ]);

  const { months, summary } = monthlySummaryResult.data;
  const categories = categoryResult.data.categories ?? [];

  // Lazy-import PDFKit (ESM-friendly)
  const { default: PDFDocument } = await import('pdfkit');
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, autoFirstPage: true });

  const filename = `financial-report-${new Date().toISOString().slice(0, 10)}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  doc.pipe(res);

  /* ── Header ─────────────────────────────────────────────────── */
  doc
    .fontSize(22)
    .font('Helvetica-Bold')
    .fillColor(COLORS.primary)
    .text('Financial Report', MARGIN, MARGIN);

  const generatedAt = new Date().toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });

  doc
    .fontSize(10)
    .font('Helvetica')
    .fillColor(COLORS.muted)
    .text(`Generated ${generatedAt} · Currency: ${targetCurrency}`, MARGIN, MARGIN + 28);

  if (summary.period_start && summary.period_end) {
    const fmt = (d) =>
      d instanceof Date
        ? d.toLocaleDateString('en-US', { month: 'short', year: 'numeric', day: 'numeric' })
        : String(d).slice(0, 10);
    doc.text(`Period: ${fmt(summary.period_start)} – ${fmt(summary.period_end)}`, MARGIN, MARGIN + 42);
  }

  drawRule(doc, MARGIN + 64);

  /* ── Summary stats ──────────────────────────────────────────── */
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .fillColor(COLORS.heading)
    .text('Summary', MARGIN, MARGIN + 80);

  let sx = MARGIN;
  const sy = MARGIN + 100;
  sx = drawStatBox(doc, sx, sy, 'Total Income', formatMoney(summary.total_income, targetCurrency), COLORS.income);
  sx = drawStatBox(doc, sx, sy, 'Total Spending', formatMoney(summary.total_spending, targetCurrency), COLORS.spending);
  sx = drawStatBox(doc, sx, sy, 'Net Balance', formatMoney(summary.net_amount, targetCurrency), COLORS.net);
  drawStatBox(doc, sx, sy, 'Transactions', String(summary.transaction_count), COLORS.primary);

  /* ── Monthly table ──────────────────────────────────────────── */
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .fillColor(COLORS.heading)
    .text('Monthly Breakdown', MARGIN, sy + 80);

  let tableY = sy + 100;

  // Header row
  doc
    .rect(MARGIN, tableY, PAGE_WIDTH - MARGIN * 2, 20)
    .fillColor(COLORS.primary)
    .fill();

  doc
    .fontSize(9)
    .font('Helvetica-Bold')
    .fillColor('#ffffff');

  doc.text('Month', COL_MONTH + 4, tableY + 6);
  doc.text('Income', COL_INCOME, tableY + 6);
  doc.text('Spending', COL_SPENDING, tableY + 6);
  doc.text('Net', COL_NET, tableY + 6);

  tableY += 20;

  const displayMonths = [...months].reverse(); // most-recent first
  for (let i = 0; i < displayMonths.length; i++) {
    const m = displayMonths[i];
    const rowH = 18;

    if (i % 2 === 0) {
      doc.rect(MARGIN, tableY, PAGE_WIDTH - MARGIN * 2, rowH).fillColor(COLORS.rowAlt).fill();
    }

    const net = m.total_income - m.total_spending;
    const netColor = net >= 0 ? COLORS.income : COLORS.spending;

    doc.fontSize(9).font('Helvetica').fillColor(COLORS.subheading);
    const periodKey = m.period ?? `${m.year}-${String(m.month).padStart(2, '0')}`;
    doc.text(formatPeriod(periodKey), COL_MONTH + 4, tableY + 5);

    doc.fillColor(COLORS.income).text(formatMoney(m.total_income, targetCurrency), COL_INCOME, tableY + 5);
    doc.fillColor(COLORS.spending).text(formatMoney(m.total_spending, targetCurrency), COL_SPENDING, tableY + 5);
    doc.fillColor(netColor).text(formatMoney(net, targetCurrency), COL_NET, tableY + 5);

    tableY += rowH;

    // Page break safety
    if (tableY > 750) {
      doc.addPage();
      tableY = MARGIN;
    }
  }

  drawRule(doc, tableY + 6);
  tableY += 24;

  /* ── Top categories ─────────────────────────────────────────── */
  doc
    .fontSize(12)
    .font('Helvetica-Bold')
    .fillColor(COLORS.heading)
    .text('Top Spending Categories', MARGIN, tableY);

  tableY += 20;

  if (tableY > 700) {
    doc.addPage();
    tableY = MARGIN;
  }

  // Header
  doc.rect(MARGIN, tableY, PAGE_WIDTH - MARGIN * 2, 20).fillColor(COLORS.primary).fill();
  doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff');
  doc.text('Category', MARGIN + 4, tableY + 6);
  doc.text('Transactions', MARGIN + 280, tableY + 6);
  doc.text('Total Spent', MARGIN + 380, tableY + 6);

  tableY += 20;

  const topCategories = [...categories]
    .filter((c) => c.total < 0 || c.total > 0)
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, 10);

  for (let i = 0; i < topCategories.length; i++) {
    const cat = topCategories[i];
    const rowH = 18;

    if (i % 2 === 0) {
      doc.rect(MARGIN, tableY, PAGE_WIDTH - MARGIN * 2, rowH).fillColor(COLORS.rowAlt).fill();
    }

    doc.fontSize(9).font('Helvetica').fillColor(COLORS.subheading);
    doc.text(cat.name || 'Uncategorised', MARGIN + 4, tableY + 5, { width: 260 });
    doc.text(String(cat.count), MARGIN + 280, tableY + 5);
    doc.fillColor(COLORS.spending).text(formatMoney(Math.abs(cat.total), targetCurrency), MARGIN + 380, tableY + 5);

    tableY += rowH;
  }

  /* ── Footer ─────────────────────────────────────────────────── */
  const footerY = doc.page.height - 40;
  drawRule(doc, footerY - 8);
  doc
    .fontSize(8)
    .font('Helvetica')
    .fillColor(COLORS.muted)
    .text('Vision — Financial Report', MARGIN, footerY, { align: 'left' })
    .text(generatedAt, MARGIN, footerY, { align: 'right', width: PAGE_WIDTH - MARGIN * 2 });

  doc.end();
}
