/// The print CSS every report shares: `buildBaseCss()` of `services/reports/index.ts` with the
/// `SECTION_CSS` of `sectionHelpers.ts`, copied character for character. The recorded cases
/// (`parity/plans/reports.jsonl`) hold the TypeScript's text, so a change there fails the replay
/// until this copy follows.
enum ReportStyles {
    // swift-format-ignore
    static let base = #"""
/* @page background paints the entire page canvas including the bottom
       margin area reserved for the printed footer. Without it, Chromium
       leaves a white strip below the footer iframe (the iframe's allotted
       height is shorter than the @page bottom margin) and the html/body
       backgrounds do not propagate into @page margin boxes. */
    @page { size: A4 portrait; margin: 0 0 28px 0; background: hsl(var(--surface)); }
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    html {
      background: hsl(var(--surface));
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    :root {
      /* Height reserved for the printed footer in the bottom margin area.
         Must match the desktop printer's bottom page margin (28px). */
      --footer-h: 28px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      background: hsl(var(--surface));
      color: hsl(var(--text));
      width: 210mm;
      font-size: 13px;
      line-height: 1.5;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    /* ── Cover ─────────────────────────────────────── */
    .cover {
      height: calc(297mm - var(--footer-h));
      display: flex;
      flex-direction: column;
      page-break-after: always;
      background: hsl(var(--surface));
    }
    .cover-band {
      height: 8px;
      background: hsl(var(--primary));
      flex-shrink: 0;
    }
    .cover-body {
      flex: 1;
      padding: 64px 52px 40px;
      display: flex;
      flex-direction: column;
    }
    .cover-eyebrow {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: hsl(var(--primary));
      margin-bottom: 12px;
    }
    .cover-title {
      font-size: 40px;
      font-weight: 700;
      color: hsl(var(--text));
      line-height: 1.1;
      margin-bottom: 10px;
    }
    .cover-subtitle {
      font-size: 15px;
      color: hsl(var(--muted));
      margin-bottom: 56px;
    }
    .cover-divider {
      width: 48px;
      height: 3px;
      background: hsl(var(--primary));
      border-radius: 2px;
      margin-bottom: 40px;
    }
    .cover-meta {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }
    .meta-row {
      display: flex;
      align-items: baseline;
      gap: 16px;
    }
    .meta-label {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: hsl(var(--muted));
      width: 72px;
      flex-shrink: 0;
    }
    .meta-value {
      font-size: 14px;
      font-weight: 500;
      color: hsl(var(--text));
    }
    .cover-footer {
      margin-top: auto;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding-top: 24px;
      border-top: 1px solid hsl(var(--border));
      font-size: 10px;
      color: hsl(var(--muted));
    }
    .cover-footer-brand {
      font-weight: 600;
      color: hsl(var(--primary));
    }

    /* ── Content pages ─────────────────────────────── */
    .page {
      padding: 40px 52px 56px;
      border-top: 4px solid hsl(var(--primary));
      /* intentionally no break-inside: avoid — sections may span pages */
    }
    .page-break {
      page-break-before: always;
    }
    /* Continuation page within the same logical section — forced break.
       Same green top border as .page so every printed page has the brand band. */
    .page-continuation {
      padding: 40px 52px 56px;
      border-top: 4px solid hsl(var(--primary));
      page-break-before: always;
    }
    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: hsl(var(--text));
      margin-bottom: 4px;
      break-after: avoid;
    }
    .section-subtitle {
      font-size: 12px;
      color: hsl(var(--muted));
      margin-bottom: 24px;
      break-after: avoid;
    }
    .section-divider {
      border: none;
      border-top: 1px solid hsl(var(--border));
      margin-bottom: 32px;
      break-after: avoid;
      page-break-after: avoid;
    }

    /* ── Placeholder (phase 1) ─────────────────────── */
    .placeholder-notice {
      text-align: center;
      padding: 80px 52px;
      color: hsl(var(--muted));
      font-size: 13px;
    }
    .placeholder-notice strong {
      display: block;
      font-size: 15px;
      color: hsl(var(--text));
      margin-bottom: 8px;
    }

\#("    ")
  /* ── KPI grid ───────────────────────────────── */
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 14px;
    margin-bottom: 28px;
  }
  .kpi-grid-3 { grid-template-columns: repeat(3, 1fr); }
  .kpi-card {
    background: hsl(var(--border) / 0.25);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .kpi-label {
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    margin-bottom: 6px;
  }
  .kpi-value {
    font-size: 20px;
    font-weight: 700;
    color: hsl(var(--text));
    line-height: 1;
    margin-bottom: 4px;
    font-variant-numeric: tabular-nums;
  }
  .kpi-sub {
    font-size: 10px;
    color: hsl(var(--muted));
  }

  /* ── Sentiment ──────────────────────────────── */
  .pos { color: hsl(var(--success)) !important; }
  .neg { color: hsl(var(--expense)) !important; }

  /* ── Chart wrapper ──────────────────────────── */
  .chart-wrap {
    margin-bottom: 28px;
    overflow: hidden;
    break-inside: avoid;
    page-break-inside: avoid;
  }

  /* ── Data table ─────────────────────────────── */
  .data-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .data-table th {
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    padding: 0 8px 8px 0;
    border-bottom: 1px solid hsl(var(--border));
  }
  .data-table td {
    padding: 5px 8px 5px 0;
    color: hsl(var(--text));
    border-bottom: 1px solid hsl(var(--border) / 0.4);
    vertical-align: middle;
  }
  .data-table .num {
    text-align: right;
    font-variant-numeric: tabular-nums;
  }

  /* ── Badges ─────────────────────────────────── */
  .badge {
    display: inline-block;
    padding: 2px 7px;
    border-radius: 99px;
    font-size: 9px;
    font-weight: 700;
    line-height: 1.4;
  }
  .badge-pos {
    background: hsl(var(--success) / 0.15);
    color: hsl(var(--success));
  }
  .badge-neg {
    background: hsl(var(--expense) / 0.15);
    color: hsl(var(--expense));
  }
  .badge-neutral {
    background: hsl(var(--border) / 0.5);
    color: hsl(var(--muted));
  }

  /* ── Stat rows ──────────────────────────────── */
  .stat-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 0;
    border-bottom: 1px solid hsl(var(--border) / 0.4);
  }
  .stat-label {
    font-size: 12px;
    color: hsl(var(--muted));
  }
  .stat-value {
    font-size: 13px;
    font-weight: 600;
    color: hsl(var(--text));
    font-variant-numeric: tabular-nums;
  }

  /* ── Empty state ────────────────────────────── */
  .empty-notice {
    text-align: center;
    padding: 40px 20px;
    color: hsl(var(--muted));
    font-size: 12px;
    background: hsl(var(--border) / 0.2);
    border-radius: 8px;
  }

  /* ── Account card ───────────────────────────── */
  .account-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 14px;
    margin-bottom: 28px;
  }
  .account-card {
    background: hsl(var(--border) / 0.25);
    border-radius: 8px;
    padding: 14px 16px;
  }
  .account-name {
    font-size: 10px;
    color: hsl(var(--muted));
    margin-bottom: 6px;
    font-weight: 600;
    letter-spacing: 0.04em;
  }
  .account-balance {
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    margin-bottom: 4px;
  }
  .account-meta {
    font-size: 10px;
    color: hsl(var(--muted));
  }

  /* ── Print break control ────────────────────── */
  .kpi-card     { break-inside: avoid; }
  .account-card { break-inside: avoid; }
  .stat-row     { break-inside: avoid; }
  .planned-day  { break-inside: avoid; }

  /* Repeat table header row when a table spans pages */
  .data-table thead { display: table-header-group; }
  /* Prevent individual rows from splitting across pages */
  .data-table tr { break-inside: avoid; page-break-inside: avoid; }
  /* Allow long cell text to wrap rather than overflow */
  .data-table td { word-break: break-word; }
  /* Cap the name column so very long strings don't blow out the layout */
  .data-table td:nth-child(2) {
    max-width: 200px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* ── Planned outlook ────────────────────────── */
  .planned-day {
    margin-bottom: 16px;
  }
  .planned-day-header {
    font-size: 10px;
    font-weight: 700;
    color: hsl(var(--muted));
    letter-spacing: 0.06em;
    text-transform: uppercase;
    margin-bottom: 6px;
    padding-bottom: 4px;
    border-bottom: 1px solid hsl(var(--border) / 0.4);
  }
  .planned-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 0;
    font-size: 11px;
  }
  .planned-row-name { color: hsl(var(--text)); flex: 1; }
  .planned-row-cat  { color: hsl(var(--muted)); font-size: 10px; margin-right: 8px; }
  .planned-row-amt  { font-variant-numeric: tabular-nums; font-weight: 600; }

  /* ── Filter notice ──────────────────────────── */
  .filter-notice {
    font-size: 10px;
    color: hsl(var(--muted));
    background: hsl(var(--border) / 0.2);
    border-radius: 6px;
    padding: 8px 12px;
    margin-bottom: 16px;
  }

  /* ── Filter impact comparison ───────────────── */
  .filter-impact { margin-top: 28px; }
  .filter-impact-title {
    font-size: 14px;
    font-weight: 700;
    color: hsl(var(--text));
    margin-bottom: 4px;
    break-after: avoid;
  }
  .filter-impact-subtitle {
    font-size: 11px;
    color: hsl(var(--muted));
    margin-bottom: 12px;
    break-after: avoid;
  }
  .filter-impact-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
  }
  .filter-impact-table th {
    text-align: left;
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: hsl(var(--muted));
    padding: 0 8px 8px 0;
    border-bottom: 1px solid hsl(var(--border));
  }
  .filter-impact-table th.num { text-align: right; }
  .filter-impact-table td {
    padding: 6px 8px 6px 0;
    color: hsl(var(--text));
    border-bottom: 1px solid hsl(var(--border) / 0.4);
    font-variant-numeric: tabular-nums;
    vertical-align: middle;
  }
  .filter-impact-table td.num { text-align: right; }
  .filter-impact-table tr { break-inside: avoid; page-break-inside: avoid; }

  /* ── Dual-chart comparison pair ────────────── */
  .chart-pair {
    display: grid;
    grid-template-columns: 1fr;
    gap: 24px;
    margin-bottom: 28px;
    break-inside: avoid;
    page-break-inside: avoid;
  }
  .chart-pair-label {
    font-size: 9px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: hsl(var(--muted));
    margin-bottom: 6px;
    break-after: avoid;
    page-break-after: avoid;
  }
"""#
}
