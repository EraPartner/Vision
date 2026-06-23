#!/usr/bin/env node
/**
 * One-time densify of asset_price_history.
 *
 * Runs the same gap-detecting backfill the daily scheduler uses, but on demand, so existing
 * sparse charts improve immediately instead of waiting for the next nightly tick. For every
 * investment whose stored daily series has an interior gap larger than the threshold, it forces
 * a provider re-fetch (bypassing the endpoint-only freshness check) and repopulates the holes.
 * If any rows are written, portfolio performance snapshots are recomputed so the Performance
 * page reflects the denser history.
 *
 * Kept off the startup/boot path on purpose — a full re-fetch can be slow and is rate-limited.
 *
 * Usage: bun run quotes:densify
 * Requires network access to the price providers and a reachable database.
 */

import { backfillHoldingGaps } from '../src/services/quoteBackfillService.js';
import { computeAndStoreSnapshots } from '../src/services/portfolioPerformanceSnapshotService.js';
import { closePool } from '../src/database/connection.js';

async function main() {
  console.log('Densifying asset price history (gap-fill across all holding windows)…');
  const result = await backfillHoldingGaps();
  console.log(
    `Gap-fill complete: checked=${result.checked}, needed=${result.needed}, `
    + `filled=${result.filled}, failed=${result.failed}`,
  );

  if (result.filled > 0) {
    console.log('New rows written — recomputing portfolio performance snapshots…');
    await computeAndStoreSnapshots();
    console.log('Snapshots recomputed.');
  } else {
    console.log('No new rows written — snapshots left unchanged.');
  }
}

main()
  .then(async () => {
    await closePool();
    process.exit(0);
  })
  .catch(async (err) => {
    console.error('Densify failed:', err?.message || err);
    await closePool().catch(() => {});
    process.exit(1);
  });
