/**
 * Shared helpers for PDF section renderers.
 *
 * Exports: HTML escaping, number formatting, SVG chart builders,
 * and the CSS string that all section styles depend on.
 */

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CHART_COLOR_VARS = ['--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8'];

// ── Escaping ───────────────────────────────────────────────────────────────

/**
 * Escape HTML special characters to prevent XSS in template strings.
 *
 * @param {unknown} str
 * @returns {string}
 */
export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// ── Formatting ─────────────────────────────────────────────────────────────

/**
 * Format a number as a currency string (e.g. "EUR 1,234.56").
 *
 * @param {number} amount
 * @param {string} [currency]
 * @returns {string}
 */
export function fmtCurrency(amount, currency = 'EUR') {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? '-\u202F' : '';
  const formatted = new Intl.NumberFormat('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(abs);
  return `${sign}${currency}\u00A0${formatted}`;
}


/**
 * Format a percentage value (e.g. "12.3%").
 *
 * @param {number} value  Raw ratio (e.g. 0.123 → "12.3%") OR plain number if isRaw=true
 * @param {boolean} [isRaw]  If true, value is already a percentage number (e.g. 12.3)
 * @returns {string}
 */
export function fmtPct(value, isRaw = false) {
  const pct = isRaw ? value : value * 100;
  const abs = Math.abs(pct);
  const sign = pct < 0 ? '-' : '+';
  return `${sign}${abs.toFixed(1)}%`;
}

/**
 * Format a Date or ISO string as "12 Jan 2025".
 *
 * @param {Date | string | null | undefined} date
 * @returns {string}
 */
export function fmtDate(date) {
  if (!date) return '—';
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * Short month label for chart axes, e.g. "Jan'25".
 *
 * @param {number} year
 * @param {number} month  1-based
 * @returns {string}
 */
export function fmtMonthLabel(year, month) {
  return `${MONTH_ABBR[(month - 1) % 12]}'${String(year).slice(2)}`;
}

/**
 * Return a CSS class name based on the sign of a numeric amount.
 *
 * @param {number} amount
 * @returns {'pos' | 'neg' | 'neutral'}
 */
export function signClass(amount) {
  if (amount > 0) return 'pos';
  if (amount < 0) return 'neg';
  return 'neutral';
}

// ── KPI cards ──────────────────────────────────────────────────────────────

/**
 * Render one KPI card. Label, value and `sub` are HTML-escaped; pass
 * `subHtml` instead of `sub` when the sub-line carries pre-built markup
 * (e.g. a badge span).
 *
 * @param {{
 *   label: string,
 *   value: string | number,
 *   cls?: string,        // sentiment class on the value ('pos' | 'neg' | …)
 *   sub?: string | null, // plain-text sub-line (escaped)
 *   subCls?: string,     // extra class on the sub-line
 *   subHtml?: string | null, // pre-escaped/markup sub-line (wins over sub)
 *   valueStyle?: string | null, // inline style on the value div
 * }} card
 * @returns {string}
 */
export function kpiCard({ label, value, cls = '', sub = null, subCls = '', subHtml = null, valueStyle = null }) {
  const subInner = subHtml ?? (sub != null ? escapeHtml(sub) : null);
  const subLine = subInner != null
    ? `<div class="${subCls ? `kpi-sub ${subCls}` : 'kpi-sub'}">${subInner}</div>`
    : '';
  return `
    <div class="kpi-card">
      <div class="kpi-label">${escapeHtml(label)}</div>
      <div class="${cls ? `kpi-value ${cls}` : 'kpi-value'}"${valueStyle ? ` style="${valueStyle}"` : ''}>${escapeHtml(value)}</div>
      ${subLine}
    </div>`;
}

/**
 * Render a grid of KPI cards.
 *
 * @param {Parameters<typeof kpiCard>[0][]} cards
 * @param {{ cols?: 3 | 4, style?: string | null }} [opts]
 * @returns {string}
 */
export function kpiGrid(cards, { cols = 4, style = null } = {}) {
  const cls = cols === 3 ? 'kpi-grid kpi-grid-3' : 'kpi-grid';
  return `<div class="${cls}"${style ? ` style="${style}"` : ''}>${cards.map(kpiCard).join('')}</div>`;
}

// ── SVG Charts ─────────────────────────────────────────────────────────────

/**
 * Standard "No data" placeholder SVG shared by the chart builders.
 *
 * @param {number} w
 * @param {number} h
 * @returns {string}
 */
function emptyChartSvg(w, h) {
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" xmlns="http://www.w3.org/2000/svg"><text x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="hsl(var(--muted))" font-size="12">No data</text></svg>`;
}

/**
 * Axis-label thinning step: render every Nth label to avoid crowding as the
 * point/group count grows.
 *
 * @param {number} count
 * @returns {number}
 */
function labelStep(count) {
  return count > 12 ? 3 : count > 6 ? 2 : 1;
}

/**
 * Render a grouped-bar chart as an SVG string.
 * Each group has two bars: income (success color) and spending (expense color).
 *
 * This is a two-series special case of {@link svgGenericGroupedBarChart} — it
 * delegates with the income/spending series config and the layout constants
 * (top padding, bar-width cap, bar gap, legend offsets, income drawn without
 * the 0.85 opacity) that reproduce the original income/spending chart exactly.
 *
 * @param {{ label: string; income: number; spending: number }[]} groups
 * @returns {string}  SVG element string
 */
export function svgGroupedBarChart(groups) {
  return svgGenericGroupedBarChart(
    groups,
    [
      { key: 'income', color: 'hsl(var(--success))', label: 'Income', opacity: null },
      { key: 'spending', color: 'hsl(var(--expense))', label: 'Expenses' },
    ],
    { padT: 12, barWMax: 18, barGap: 2, legendRectY: 0, legendTextY: 7 },
  );
}

/**
 * Render a horizontal-bar chart as an SVG string.
 * Items are displayed top-to-bottom in the order given.
 *
 * @param {{ label: string; value: number; fmtValue?: string }[]} items
 * @param {{ maxItems?: number }} [opts]
 * @returns {string}  SVG element string
 */
export function svgHorizontalBars(items, { maxItems = 10 } = {}) {
  const top = items.slice(0, maxItems);
  if (!top.length) {
    return `<svg viewBox="0 0 500 40" width="100%" xmlns="http://www.w3.org/2000/svg"><text x="250" y="22" text-anchor="middle" fill="hsl(var(--muted))" font-size="12">No data</text></svg>`;
  }

  const ROW_H = 24;
  const H = top.length * ROW_H + 8;
  const W = 500;
  const LABEL_W = 160;
  const VALUE_W = 70;
  const BAR_AREA = W - LABEL_W - VALUE_W;
  const maxVal = Math.max(...top.map(it => Math.abs(it.value)), 1);

  let rows = '';
  for (let i = 0; i < top.length; i++) {
    const it = top[i];
    const y = 4 + i * ROW_H;
    const barH = 14;
    const barW = Math.max(2, (Math.abs(it.value) / maxVal) * BAR_AREA);
    const colorVar = CHART_COLOR_VARS[i % CHART_COLOR_VARS.length];
    const label = it.label.length > 26 ? it.label.slice(0, 24) + '\u2026' : it.label;
    const valueStr = it.fmtValue ?? '';

    rows += `<text x="${LABEL_W - 4}" y="${(y + barH - 2).toFixed(0)}" text-anchor="end" font-size="10" fill="hsl(var(--text))">${escapeHtml(label)}</text>`;
    rows += `<rect x="${LABEL_W}" y="${y}" width="${barW.toFixed(1)}" height="${barH}" fill="hsl(var(${colorVar}))" rx="3" opacity="0.8"/>`;
    rows += `<text x="${(LABEL_W + barW + 6).toFixed(1)}" y="${(y + barH - 2).toFixed(0)}" font-size="10" fill="hsl(var(--muted))">${escapeHtml(valueStr)}</text>`;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">${rows}</svg>`;
}

/**
 * Generic grouped bar chart — configurable series colours.
 * Each group has N bars defined by seriesDefs.
 *
 * Layout constants have defaults matching the N-series (tax/portfolio) charts;
 * the two-series income/spending chart ({@link svgGroupedBarChart}) overrides
 * them via `opts`. A `seriesDefs` entry may set `opacity: null` to omit the
 * bar's opacity attribute entirely (default is 0.85).
 *
 * @param {{ label: string; [key: string]: number | string }[]} groups
 * @param {{ key: string; color: string; label: string; opacity?: number | null }[]} seriesDefs
 * @param {{ padT?: number; barWMax?: number; barGap?: number; legendRectY?: number; legendTextY?: number }} [opts]
 * @returns {string}
 */
export function svgGenericGroupedBarChart(groups, seriesDefs, opts = {}) {
  const { padT = 18, barWMax = 14, barGap = 1, legendRectY = 4, legendTextY = 11 } = opts;
  const W = 500, H = 160;
  const PAD_L = 10, PAD_R = 10, PAD_T = padT, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  if (!groups.length || !seriesDefs.length) {
    return emptyChartSvg(W, H);
  }

  const numSeries = seriesDefs.length;
  const maxVal = Math.max(
    ...groups.flatMap(g => seriesDefs.map(s => Math.abs(Number(g[s.key]) || 0))),
    1
  );
  const numGroups = groups.length;
  const groupW = chartW / numGroups;
  const barW = Math.max(3, Math.min(barWMax, (groupW - 6) / numSeries));
  const baseline = PAD_T + chartH;

  let rects = `<line x1="${PAD_L}" y1="${baseline}" x2="${W - PAD_R}" y2="${baseline}" stroke="hsl(var(--border))" stroke-width="1"/>`;
  let labels = '';

  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const cx = PAD_L + i * groupW + groupW / 2;
    const groupTotalW = numSeries * barW + (numSeries - 1) * barGap;
    let startX = cx - groupTotalW / 2;

    for (let s = 0; s < seriesDefs.length; s++) {
      const val = Math.abs(Number(g[seriesDefs[s].key]) || 0);
      const bH = Math.max(1, (val / maxVal) * chartH);
      const op = seriesDefs[s].opacity;
      const opacityAttr = op === null ? '' : ` opacity="${op ?? 0.85}"`;
      rects += `<rect x="${startX.toFixed(1)}" y="${(baseline - bH).toFixed(1)}" width="${barW.toFixed(1)}" height="${bH.toFixed(1)}" fill="${seriesDefs[s].color}" rx="2"${opacityAttr}/>`;
      startX += barW + barGap;
    }

    const step = labelStep(numGroups);
    if (i % step === 0) {
      labels += `<text x="${cx.toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="hsl(var(--muted))">${escapeHtml(g.label)}</text>`;
    }
  }

  let legend = '';
  let lx = PAD_L;
  for (const s of seriesDefs) {
    legend += `<rect x="${lx}" y="${legendRectY}" width="8" height="8" rx="2" fill="${s.color}"/>`;
    legend += `<text x="${lx + 10}" y="${legendTextY}" font-size="8" fill="hsl(var(--muted))">${escapeHtml(s.label)}</text>`;
    lx += 70;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">${legend}${rects}${labels}</svg>`;
}

/**
 * Line chart overlaying 2–3 series over a shared time axis.
 * Each series entry in `series` is { label, color, values: number[] }.
 * `labels` is a parallel array of x-axis labels (same length as values).
 *
 * @param {{ label: string; color: string; values: number[] }[]} series
 * @param {{ labels?: string[]; height?: number }} [opts]
 * @returns {string}
 */
export function svgLineChart(series, { labels = [], height = 160 } = {}) {
  const W = 500;
  const H = height;
  const PAD_L = 10, PAD_R = 10, PAD_T = 18, PAD_B = 28;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;

  const allValues = series.flatMap(s => s.values);
  if (!allValues.length || !labels.length) {
    return emptyChartSvg(W, H);
  }

  const maxVal = Math.max(...allValues.map(Math.abs), 1);
  const n = labels.length;
  const baseline = PAD_T + chartH;

  /** @param {number} i */
  const xOf = (i) => PAD_L + (i / Math.max(n - 1, 1)) * chartW;
  /** @param {number} v */
  const yOf = (v) => baseline - (v / maxVal) * chartH;

  let paths = '';
  let dots = '';

  for (const s of series) {
    const pts = s.values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`);
    paths += `<polyline points="${pts.join(' ')}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (let i = 0; i < s.values.length; i++) {
      dots += `<circle cx="${xOf(i).toFixed(1)}" cy="${yOf(s.values[i]).toFixed(1)}" r="2.5" fill="${s.color}"/>`;
    }
  }

  // X-axis baseline
  let axis = `<line x1="${PAD_L}" y1="${baseline}" x2="${W - PAD_R}" y2="${baseline}" stroke="hsl(var(--border))" stroke-width="1"/>`;

  // X labels
  let xLabels = '';
  const step = labelStep(n);
  for (let i = 0; i < n; i += step) {
    xLabels += `<text x="${xOf(i).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="8.5" fill="hsl(var(--muted))">${escapeHtml(labels[i])}</text>`;
  }

  // Legend
  let legend = '';
  let lx = PAD_L;
  for (const s of series) {
    legend += `<line x1="${lx}" y1="8" x2="${lx + 16}" y2="8" stroke="${s.color}" stroke-width="2"/>`;
    legend += `<text x="${lx + 20}" y="11" font-size="8" fill="hsl(var(--muted))">${escapeHtml(s.label)}</text>`;
    lx += 80;
  }

  return `<svg viewBox="0 0 ${W} ${H}" width="100%" xmlns="http://www.w3.org/2000/svg">${legend}${axis}${paths}${dots}${xLabels}</svg>`;
}

// ── Section CSS ────────────────────────────────────────────────────────────

export const SECTION_CSS = `
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
`;
