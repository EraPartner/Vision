import { sql } from "kysely";
import type { RawBuilder } from "kysely";

/**
 * Within a calendar day, bank-sequenced rows follow the bank's order. Rows
 * without that evidence follow them in insertion order, so manual same-day
 * activity remains a post-statement delta. Unknown chronology is not inferred.
 * `alias` is a repository-owned table alias, emitted as a quoted identifier.
 */
export function bankChronologySql(alias: string): RawBuilder<unknown> {
  const t = sql.id(alias);
  return sql`COALESCE(${t}.bank_sequence, 1000000000000000000000000000000::numeric + ${t}.id)`;
}
