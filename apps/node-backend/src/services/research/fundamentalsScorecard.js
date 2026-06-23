/**
 * Fundamentals heuristic scorecard (Research Pillar D — ADR-081).
 *
 * Pure, dependency-free rules engine. Takes a normalized (extended) fundamentals
 * snapshot and flags metrics that look weak by well-known rules of thumb,
 * producing per-metric flags (severity + machine `code` + English `reason`) and
 * an overall 0–100 health score / letter grade.
 *
 * Design notes:
 *   - Missing fields are SKIPPED, never penalized — free-tier providers expose
 *     different subsets, and absence is not a negative signal.
 *   - Each flag carries a stable `code` (`<metric>.<severity>`) and a stable
 *     `reasonKey` (`<metric>.<slug>`, unique per distinct message — `code` alone
 *     collides where one severity has two reasons). The frontend localizes via
 *     `reasonKey`; `reason` is the English fallback for API consumers/tests.
 *   - Thresholds are deliberately generic (not sector-tuned) — `sector` is
 *     surfaced on the fundamentals payload so the UI can caveat where relevant.
 */

const PENALTY = Object.freeze({ ok: 0, caution: 4, warn: 9, risk: 16 });

/**
 * Each rule reads one numeric field and returns [severity, reason, benchmark, slug].
 * `slug` is the stable per-message id (combined into `reasonKey` as `<metric>.<slug>`).
 * `better` documents the favourable direction for the UI.
 */
const RULES = [
  // ── Leverage & liquidity ──────────────────────────────────────────────────
  {
    key: 'currentRatio', category: 'liquidity', better: 'higher',
    evaluate: (v) => v < 1
      ? ['risk', 'Current liabilities exceed current assets — short-term liquidity risk', '≥ 1.5', 'deficit']
      : v < 1.5
        ? ['caution', 'Thin short-term liquidity cushion', '≥ 1.5', 'thin']
        : ['ok', 'Adequate short-term liquidity', '≥ 1.5', 'ok'],
  },
  {
    key: 'quickRatio', category: 'liquidity', better: 'higher',
    evaluate: (v) => v < 1
      ? ['warn', 'Liquid assets alone do not cover current liabilities', '≥ 1', 'uncovered']
      : ['ok', 'Liquid assets cover current liabilities', '≥ 1', 'ok'],
  },
  {
    key: 'debtToEquity', category: 'leverage', better: 'lower',
    evaluate: (v) => v < 0
      ? ['risk', 'Negative shareholder equity', '< 1', 'negativeEquity']
      : v > 2
        ? ['risk', 'High leverage — debt is more than double equity', '< 1', 'high']
        : v > 1
          ? ['warn', 'Elevated leverage', '< 1', 'elevated']
          : ['ok', 'Leverage within a conservative range', '< 1', 'ok'],
  },
  {
    key: 'interestCoverage', category: 'leverage', better: 'higher',
    evaluate: (v) => v < 1.5
      ? ['risk', 'Operating income barely covers interest expense', '> 3', 'thin']
      : v < 3
        ? ['warn', 'Modest interest coverage', '> 3', 'modest']
        : ['ok', 'Comfortable interest coverage', '> 3', 'ok'],
  },
  // ── Profitability ──────────────────────────────────────────────────────────
  {
    key: 'profitMargin', category: 'profitability', better: 'higher',
    evaluate: (v) => v < 0
      ? ['risk', 'Company is unprofitable on a net basis', '> 5%', 'unprofitable']
      : v < 0.05
        ? ['caution', 'Slim net margin', '> 5%', 'slim']
        : ['ok', 'Healthy net margin', '> 5%', 'ok'],
  },
  {
    key: 'operatingMargin', category: 'profitability', better: 'higher',
    evaluate: (v) => v < 0
      ? ['warn', 'Core operations are loss-making', '> 0%', 'lossmaking']
      : ['ok', 'Operations are profitable', '> 0%', 'ok'],
  },
  {
    key: 'grossMargin', category: 'profitability', better: 'higher',
    evaluate: (v) => v < 0.2
      ? ['caution', 'Thin gross margin leaves little room for opex', '> 20%', 'thin']
      : ['ok', 'Solid gross margin', '> 20%', 'ok'],
  },
  {
    key: 'returnOnEquity', category: 'profitability', better: 'higher',
    evaluate: (v) => v < 0
      ? ['warn', 'Negative return on equity', '> 8%', 'negative']
      : v < 0.05
        ? ['caution', 'Low return on equity', '> 8%', 'low']
        : ['ok', 'Strong return on equity', '> 8%', 'ok'],
  },
  // ── Cash flow ────────────────────────────────────────────────────────────
  {
    key: 'freeCashFlow', category: 'cashflow', better: 'higher',
    evaluate: (v) => v < 0
      ? ['warn', 'Negative free cash flow — burning cash', '> 0', 'negative']
      : ['ok', 'Generates positive free cash flow', '> 0', 'ok'],
  },
  {
    key: 'fcfYield', category: 'cashflow', better: 'higher',
    evaluate: (v) => v < 0
      ? ['warn', 'Negative free-cash-flow yield', '> 2%', 'negative']
      : v < 0.02
        ? ['caution', 'Low free-cash-flow yield relative to price', '> 2%', 'low']
        : ['ok', 'Attractive free-cash-flow yield', '> 2%', 'ok'],
  },
  // ── Growth ───────────────────────────────────────────────────────────────
  {
    key: 'revenueGrowth', category: 'growth', better: 'higher',
    evaluate: (v) => v < 0
      ? ['warn', 'Revenue is shrinking year-over-year', '> 0%', 'shrinking']
      : v < 0.03
        ? ['caution', 'Sluggish revenue growth', '> 0%', 'sluggish']
        : ['ok', 'Revenue is growing', '> 0%', 'ok'],
  },
  {
    key: 'earningsGrowth', category: 'growth', better: 'higher',
    evaluate: (v) => v < 0
      ? ['caution', 'Earnings are declining year-over-year', '> 0%', 'declining']
      : ['ok', 'Earnings are growing', '> 0%', 'ok'],
  },
  // ── Valuation ──────────────────────────────────────────────────────────────
  {
    key: 'pe', category: 'valuation', better: 'lower',
    evaluate: (v) => v < 0
      ? ['warn', 'No trailing earnings to value against (negative P/E)', '< 40', 'noEarnings']
      : v > 80
        ? ['warn', 'Very high earnings multiple', '< 40', 'veryHigh']
        : v > 40
          ? ['caution', 'Rich earnings multiple', '< 40', 'rich']
          : ['ok', 'Earnings multiple in a reasonable range', '< 40', 'ok'],
  },
  {
    key: 'pegRatio', category: 'valuation', better: 'lower',
    evaluate: (v) => v <= 0
      ? ['caution', 'PEG not meaningful (non-positive)', '< 2', 'notMeaningful']
      : v > 3
        ? ['warn', 'Price looks expensive relative to growth', '< 2', 'expensive']
        : v > 2
          ? ['caution', 'Price somewhat rich relative to growth', '< 2', 'rich']
          : ['ok', 'Price reasonable relative to growth', '< 2', 'ok'],
  },
  {
    key: 'priceToBook', category: 'valuation', better: 'lower',
    evaluate: (v) => v > 10
      ? ['caution', 'Trading at a steep premium to book value', '< 10', 'premium']
      : ['ok', 'Price-to-book within a normal range', '< 10', 'ok'],
  },
  // ── Dividend ───────────────────────────────────────────────────────────────
  {
    key: 'payoutRatio', category: 'dividend', better: 'lower',
    evaluate: (v) => v > 1
      ? ['warn', 'Dividend exceeds earnings — payout may be unsustainable', '< 80%', 'unsustainable']
      : v > 0.8
        ? ['caution', 'High payout ratio leaves little earnings retained', '< 80%', 'high']
        : ['ok', 'Dividend comfortably covered by earnings', '< 80%', 'ok'],
  },
  {
    key: 'dividendYield', category: 'dividend', better: 'higher',
    evaluate: (v) => v > 0.08
      ? ['caution', 'Unusually high yield can signal a yield trap', '—', 'yieldTrap']
      : ['ok', 'Dividend yield in a normal range', '—', 'ok'],
  },
];

function gradeFor(score) {
  if (score == null) return 'unknown';
  if (score >= 85) return 'strong';
  if (score >= 70) return 'healthy';
  if (score >= 55) return 'mixed';
  if (score >= 40) return 'weak';
  return 'poor';
}

/**
 * @param {Record<string, unknown>|undefined|null} fundamentals
 * @returns {{ score: number|null, grade: string, evaluated: number,
 *   counts: Record<string, number>, flags: Array<object> }}
 */
export function fundamentalsScorecard(fundamentals) {
  const empty = { score: null, grade: 'unknown', evaluated: 0, counts: { ok: 0, caution: 0, warn: 0, risk: 0 }, flags: [] };
  if (!fundamentals || typeof fundamentals !== 'object') return empty;

  const flags = [];
  const counts = { ok: 0, caution: 0, warn: 0, risk: 0 };
  let penalty = 0;

  for (const rule of RULES) {
    const raw = fundamentals[rule.key];
    const value = Number(raw);
    if (raw == null || !Number.isFinite(value)) continue;
    const [severity, reason, benchmark, slug] = rule.evaluate(value);
    flags.push({
      metric: rule.key,
      category: rule.category,
      better: rule.better,
      value,
      severity,
      code: `${rule.key}.${severity}`,
      reasonKey: `${rule.key}.${slug}`,
      reason,
      benchmark,
    });
    counts[severity] = (counts[severity] ?? 0) + 1;
    penalty += PENALTY[severity] ?? 0;
  }

  const evaluated = flags.length;
  if (evaluated === 0) return empty;

  const score = Math.max(0, Math.min(100, Math.round(100 - penalty)));
  // Surface worst-first so the UI leads with problems.
  const order = { risk: 0, warn: 1, caution: 2, ok: 3 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);

  return { score, grade: gradeFor(score), evaluated, counts, flags };
}

export default { fundamentalsScorecard };
