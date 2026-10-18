/** Aliases are fixed repository identifiers, never request input. */
export const openTransferRow = (alias: string) => `${alias}.is_active
  AND ${alias}.is_transfer = false AND ${alias}.transfer_source IS NULL
  AND ${alias}.account_id IS NOT NULL`;

export const transferCandidate = (a: string, b: string) => `
  ${openTransferRow(b)} AND ${b}.amount = -${a}.amount
  AND COALESCE(${b}.currency, 'EUR') = COALESCE(${a}.currency, 'EUR')
  AND ${b}.account_id <> ${a}.account_id
  AND ${b}.date BETWEEN ${a}.date - $1::int AND ${a}.date + $1::int
  AND NOT EXISTS (SELECT 1 FROM transfer_dismissals d
    WHERE d.txn_a_id = LEAST(${a}.id, ${b}.id)
      AND d.txn_b_id = GREATEST(${a}.id, ${b}.id))`;

// A count capped at two distinguishes unique from ambiguous without materializing
// a dense graph. The reverse probe sees the full corpus, never a suggestion page.
export const candidateCount = (a: string, b: string) => `
  (SELECT count(*) FROM (SELECT ${b}.id FROM transactions ${b}
    WHERE ${transferCandidate(a, b)} LIMIT 2) candidates)`;
