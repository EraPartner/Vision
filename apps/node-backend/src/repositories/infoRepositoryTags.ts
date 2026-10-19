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

import { sql } from 'kysely';
import type { RawBuilder } from 'kysely';
import { checkedRows } from '../database/db.ts';
import { tagPivotRowSchema } from '../database/rows/info.ts';
import { validateInt4Ids } from '../lib/filterBuilder.ts';
import { convertRowsToEur } from '../services/currency/currencyConversionService.ts';
import { partitionConvertedRows } from "../lib/unconvertedTally.ts";
import { periodPivotConversion } from './infoRepositoryRecipients.ts';
import type { PeriodPivotConversion } from './infoRepositoryRecipients.ts';
import {
  andClauses,
  buildPeriodPivot,
  mapRowsForAmountConversion,
} from './infoRepositoryHelpers.ts';
import type { PeriodPivotEntity } from './infoRepositoryHelpers.ts';

export interface TagPivotOptions {
  targetCurrency?: string | undefined;
  bucket?: string | undefined;
  startDate?: string | null | undefined;
  endDate?: string | null | undefined;
  tagIds?: number[] | null | undefined;
  allTags?: boolean | undefined;
}

export const tagInsightsRepository = {
  async getTagPivot({
    targetCurrency = 'EUR',
    bucket = 'monthly',
    startDate = null,
    endDate = null,
    tagIds = null,
    allTags = false,
  }: TagPivotOptions = {}): Promise<{
    tagPivot: Record<string, PeriodPivotEntity[]>;
    conversion: PeriodPivotConversion;
  }> {
    // Tag pivot is rendered either for an explicit selection on a saved chart or
    // for an "all tags" dynamic source. With no selection and no all-flag there
    // is nothing to chart, so short-circuit instead of scanning every tagged
    // expense row.
    const validTagIds = validateInt4Ids(tagIds, 'tagIds');
    if (!allTags && validTagIds.length === 0)
      return { tagPivot: {}, conversion: periodPivotConversion([]) };

    const periodExpr = bucket === 'yearly' ? sql`TO_CHAR(t.date, 'YYYY')` : sql`TO_CHAR(t.date, 'YYYY-MM')`;

    const filters: RawBuilder<unknown>[] = [];
    // "all tags" drops the inclusion filter entirely so every tag with spend in
    // range is returned; the client caps to top-N + Other.
    if (!allTags) filters.push(sql`tt.tag_id = ANY(${validTagIds}::int[])`);
    if (startDate) filters.push(sql`t.date >= ${startDate}`);
    if (endDate) filters.push(sql`t.date <= ${endDate}`);

    // Aggregate per (tag, period, date, currency) in SQL. amount < 0 is pinned
    // so ABS distributes over the same-sign SUM; per-date conversion matches the
    // recipient/category pivots. The (transaction_id, tag_id) PK guarantees one
    // junction row per tag, so COUNT(*) is the transaction count for that tag.
    const rows = await checkedRows(tagPivotRowSchema, sql`
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
        ${andClauses(filters)}
      GROUP BY tt.tag_id, tg.slug, ${periodExpr}, t.date, t.currency
    `);

    const all = await convertRowsToEur(
      mapRowsForAmountConversion(rows, 'abs_amount', false),
      targetCurrency,
      { useHistoricalRatesByDate: true, dateField: 'date' }
    );
    const { converted } = partitionConvertedRows(all);

    const tagPivot = buildPeriodPivot(converted, {
      idField: 'tag_id',
      labelField: 'tag_slug',
      idKey: 'tagId',
      labelKey: 'slug',
    });

    return { tagPivot, conversion: periodPivotConversion(all) };
  },
};

