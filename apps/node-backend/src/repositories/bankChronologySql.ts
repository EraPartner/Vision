import { sql } from "kysely";
import type { RawBuilder } from "kysely";

/**
 * Within a calendar day, bank-sequenced rows follow the bank's order. Rows
 * without that evidence follow them in insertion order, so manual same-day
 * activity remains a post-statement delta. Unknown chronology is not inferred.
 * `alias` is a repository-owned table alias, emitted as a quoted identifier.
 *
 * The value is a `dec_key` sort key (text), not a number: `bank_sequence` is a
 * DECIMAL_TEXT(18,0), and 10^30 + id keeps every unsequenced row after every
 * sequenced one (a bank sequence is below 10^18) and in id order among
 * themselves. Use it only to order rows (ORDER BY, a window ORDER BY, or a
 * row-value comparison against another chronology key); it is the expression
 * of the `idx_transactions_bank_chronology` index.
 */
export function bankChronologySql(alias: string): RawBuilder<unknown> {
  const t = sql.id(alias);
  return sql`dec_key(coalesce(${t}.bank_sequence, dec_add('1000000000000000000000000000000', ${t}.id)))`;
}
