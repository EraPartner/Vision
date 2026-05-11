#!/usr/bin/env node
/**
 * Print pg_stat_user_indexes usage for the transactions table.
 *
 * Feeds the "drop unused composites" follow-up: run against a populated
 * prod-like DB, share the output, then a follow-up migration drops indexes
 * with idx_scan = 0 (or trivially low) that are covered by composites.
 *
 * Usage: bun run db:index-stats
 */

import { query, closePool } from '../src/database/connection.js';

async function main() {
  const { rows } = await query(
    `SELECT
        indexrelname        AS index_name,
        idx_scan            AS scans,
        idx_tup_read        AS tuples_read,
        idx_tup_fetch       AS tuples_fetched,
        pg_size_pretty(pg_relation_size(indexrelid)) AS size
       FROM pg_stat_user_indexes
      WHERE relname = 'transactions'
      ORDER BY idx_scan ASC, indexrelname ASC`
  );

  if (rows.length === 0) {
    console.log('No indexes found on transactions table.');
    return;
  }

  console.log('transactions index usage (sorted by scans ASC — unused first):');
  console.log('');
  console.table(rows);
  console.log('');
  console.log('Hint: indexes with scans = 0 are candidates for DROP if their leading');
  console.log('column is also the leading column of a composite that satisfies the');
  console.log('same predicates.');
}

main()
  .catch((err) => {
    console.error('index-stats failed:', err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
