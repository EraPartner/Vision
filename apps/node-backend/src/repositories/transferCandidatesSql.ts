import { sql } from "kysely";
import type { RawBuilder } from "kysely";

/** Aliases are fixed repository identifiers, emitted as quoted identifiers. */
export const openTransferRow = (alias: string): RawBuilder<unknown> => {
  const t = sql.id(alias);
  return sql`${t}.is_active = 1
  AND ${t}.is_transfer = 0 AND ${t}.transfer_source IS NULL
  AND ${t}.account_id IS NOT NULL`;
};

export const transferCandidate = (
  a: string,
  b: string,
  windowDays: number,
): RawBuilder<unknown> => {
  const ta = sql.id(a);
  const tb = sql.id(b);
  // Both sides are canonical DECIMAL_TEXT(18,4) text and dec_neg keeps the
  // scale, so text equality is exact here and can use the amount index.
  return sql`
  ${openTransferRow(b)} AND ${tb}.amount = dec_neg(${ta}.amount)
  AND COALESCE(${tb}.currency, 'EUR') = COALESCE(${ta}.currency, 'EUR')
  AND ${tb}.account_id <> ${ta}.account_id
  AND ${tb}.date BETWEEN add_days(${ta}.date, ${-windowDays}) AND add_days(${ta}.date, ${windowDays})
  AND NOT EXISTS (SELECT 1 FROM transfer_dismissals d
    WHERE d.txn_a_id = min(${ta}.id, ${tb}.id)
      AND d.txn_b_id = max(${ta}.id, ${tb}.id))`;
};

// A count capped at two distinguishes unique from ambiguous without materializing
// a dense graph. The reverse probe sees the full corpus, never a suggestion page.
export const candidateCount = (
  a: string,
  b: string,
  windowDays: number,
): RawBuilder<unknown> => sql`
  (SELECT count(*) FROM (SELECT ${sql.id(b)}.id FROM transactions ${sql.id(b)}
    WHERE ${transferCandidate(a, b, windowDays)} LIMIT 2) candidates)`;
