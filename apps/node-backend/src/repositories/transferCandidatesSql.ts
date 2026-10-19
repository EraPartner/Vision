import { sql } from "kysely";
import type { RawBuilder } from "kysely";

/** Aliases are fixed repository identifiers, emitted as quoted identifiers. */
export const openTransferRow = (alias: string): RawBuilder<unknown> => {
  const t = sql.id(alias);
  return sql`${t}.is_active
  AND ${t}.is_transfer = false AND ${t}.transfer_source IS NULL
  AND ${t}.account_id IS NOT NULL`;
};

export const transferCandidate = (
  a: string,
  b: string,
  windowDays: number,
): RawBuilder<unknown> => {
  const ta = sql.id(a);
  const tb = sql.id(b);
  return sql`
  ${openTransferRow(b)} AND ${tb}.amount = -${ta}.amount
  AND COALESCE(${tb}.currency, 'EUR') = COALESCE(${ta}.currency, 'EUR')
  AND ${tb}.account_id <> ${ta}.account_id
  AND ${tb}.date BETWEEN ${ta}.date - ${windowDays}::int AND ${ta}.date + ${windowDays}::int
  AND NOT EXISTS (SELECT 1 FROM transfer_dismissals d
    WHERE d.txn_a_id = LEAST(${ta}.id, ${tb}.id)
      AND d.txn_b_id = GREATEST(${ta}.id, ${tb}.id))`;
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
