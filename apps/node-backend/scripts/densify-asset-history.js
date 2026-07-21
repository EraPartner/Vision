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
 * Usage: bun run quotes:densify [--yes]
 *   The operation WRITES to asset_price_history, so it confirms the target
 *   database first. Pass --yes (or -y / --force) to skip the prompt in
 *   automation; a non-interactive run without --yes aborts rather than writing
 *   to the wrong environment unattended.
 * Requires network access to the price providers and a reachable database.
 */

import { createInterface } from 'node:readline';
import { backfillHoldingGaps } from '../src/services/quoteBackfillService.js';
import { computeAndStoreSnapshots } from '../src/services/portfolioPerformanceSnapshotService.js';
import { closePool } from '../src/database/connection.js';

const args = new Set(process.argv.slice(2));
const ASSUME_YES = args.has('--yes') || args.has('-y') || args.has('--force');

/** Host:port/dbname of the target DB, credentials stripped, for the prompt. */
function describeTargetDb() {
  const url = process.env.DATABASE_URL;
  if (!url) return 'the default local database (DATABASE_URL unset)';
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return 'the configured database';
  }
}

/** Interactive y/N confirmation; false when there is no TTY to prompt on. */
async function confirm(question) {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await new Promise((resolve) => rl.question(question, resolve));
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

async function main() {
  if (!ASSUME_YES) {
    console.log(`This re-fetches quotes and WRITES new rows into asset_price_history on:`);
    console.log(`  ${describeTargetDb()}`);
    const ok = await confirm('Proceed? [y/N] ');
    if (!ok) {
      console.log(process.stdin.isTTY
        ? 'Aborted.'
        : 'Aborted: no TTY to confirm on — re-run with --yes to proceed unattended.');
      return;
    }
  }

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
