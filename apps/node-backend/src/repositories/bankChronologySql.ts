/**
 * Within a calendar day, bank-sequenced rows follow the bank's order. Rows
 * without that evidence follow them in insertion order, so manual same-day
 * activity remains a post-statement delta. Unknown chronology is not inferred.
 * Only interpolate repository-owned SQL aliases, never user input.
 */
export function bankChronologySql(alias: string): string {
  return `COALESCE(${alias}.bank_sequence, 1000000000000000000000000000000::numeric + ${alias}.id)`;
}
