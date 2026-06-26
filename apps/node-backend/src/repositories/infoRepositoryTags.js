/**
 * Info sub-repository: tag spending insights.
 *
 * Tag pivot: per-tag, per-period spending breakdown. Mirrors recipientPivot
 * (infoRepositoryRecipients) but grouped by tag instead of recipient. Used by
 * the custom charts feature so a saved chart can render per-tag series.
 *
 * Spending lens (matches the recipient/merchant pivot): expenses only
 * (`amount < 0`), `is_active = true`, and internal transfers (ADR-083) always
 * excluded — a checking->savings move carries no spend intent. Because tags are
 * an orthogonal dimension (ADR-052) a transaction may carry several selected
 * tags; it contributes to EACH of those tags' totals (same OR semantics as the
 * transaction-list tag filter), so per-tag lines can legitimately overlap.
 */

import { query } from '../database/connection.js';
import { convertRowsToEur } from '../services/currency/currencyConversionService.js';
import {
  roundToCents,
  mapRowsForAmountConversion,
} from './infoRepositoryHelpers.js';

export const tagInsightsRepository = {
  async getTagPivot(targetCurrency = 'EUR', { bucket = 'monthly', startDate = null, endDate = null, tagIds = null, allTags = false } = {}) {
    // Tag pivot is rendered either for an explicit selection on a saved chart or
    // for an "all tags" dynamic source. With no selection and no all-flag there
    // is nothing to chart, so short-circuit instead of scanning every tagged
    // expense row.
    const validTagIds = Array.isArray(tagIds)
      ? tagIds.filter((id) => Number.isInteger(id) && id > 0 && id < 2147483647)
      : [];
    if (!allTags && validTagIds.length === 0) return { tagPivot: {} };

    const periodExpr = bucket === 'yearly' ? "TO_CHAR(t.date, 'YYYY')" : "TO_CHAR(t.date, 'YYYY-MM')";

    const params = [];
    const dateFilters = [];
    if (startDate) { params.push(startDate); dateFilters.push(`t.date >= $${params.length}`); }
    if (endDate) { params.push(endDate); dateFilters.push(`t.date <= $${params.length}`); }

    // "all tags" drops the inclusion filter entirely so every tag with spend in
    // range is returned; the client caps to top-N + Other.
    let tagInclude = '';
    if (!allTags) {
      params.push(validTagIds);
      tagInclude = `AND tt.tag_id = ANY($${params.length}::int[])`;
    }

    // Aggregate per (tag, period, date, currency) in SQL. amount < 0 is pinned
    // so ABS distributes over the same-sign SUM; per-date conversion matches the
    // recipient/category pivots. The (transaction_id, tag_id) PK guarantees one
    // junction row per tag, so COUNT(*) is the transaction count for that tag.
    const sql = `
      SELECT
        tt.tag_id      AS tag_id,
        tg.slug        AS tag_slug,
        ${periodExpr}  AS period,
        t.date, t.currency,
        SUM(ABS(t.amount)) AS abs_amount,
        COUNT(*)           AS cnt
      FROM transactions t
      JOIN transaction_tags tt ON tt.transaction_id = t.id
      JOIN tags tg ON tg.id = tt.tag_id
      WHERE t.is_active = true
        AND t.amount < 0
        AND t.is_transfer = false
        ${tagInclude}
        ${dateFilters.length > 0 ? `AND ${dateFilters.join(' AND ')}` : ''}
      GROUP BY tt.tag_id, tg.slug, ${periodExpr}, t.date, t.currency
    `;

    const result = await query(sql, params);

    const converted = await convertRowsToEur(
      mapRowsForAmountConversion(result.rows, 'abs_amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );

    const periodTagMap = {};
    for (const row of converted) {
      const period = row.period;
      const tid = parseInt(row.tag_id, 10);
      const eur = Math.abs(row.amount_eur);
      const cnt = parseInt(row.cnt, 10) || 0;

      if (!periodTagMap[period]) periodTagMap[period] = {};
      if (!periodTagMap[period][tid]) {
        periodTagMap[period][tid] = { tagId: tid, slug: row.tag_slug, total: 0, transactionCount: 0 };
      }
      periodTagMap[period][tid].total += eur;
      periodTagMap[period][tid].transactionCount += cnt;
    }

    const tagPivot = {};
    for (const [period, tags] of Object.entries(periodTagMap)) {
      tagPivot[period] = Object.values(tags)
        .map((tg) => ({ ...tg, total: roundToCents(tg.total) }))
        .sort((a, b) => a.total - b.total);
    }

    return { tagPivot };
  },
};

export default tagInsightsRepository;
