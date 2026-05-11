#!/usr/bin/env node
/**
 * Scan apps/node-backend/src for joins between `transactions` and any
 * `*_raw_transactions` table where rounding-sensitive arithmetic happens on
 * the amount columns.
 *
 * Today both sides are NUMERIC(15,2), so this should print nothing. The
 * detector exists so we can revisit "widen raw bank tables to NUMERIC(18,4)"
 * with evidence if/when monetary precision drift surfaces. Widening only one
 * side blindly would introduce a new mismatch — wait for a real signal.
 *
 * Usage: bun run db:precision-drift
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', 'src');

const RAW_TABLE_RE = /\b(belfius|revolut|kbc|sabb|wise|vision|custom|manual)_raw_transactions\b/i;
const TRANSACTIONS_TOKEN = /\btransactions\b/;
const ARITHMETIC_AMOUNT_RE = /\bamount\s*[*/]|\b[*/]\s*\w*amount\b/i;

const findings = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full);
    } else if (/\.(js|mjs|ts)$/.test(entry)) {
      scanFile(full);
    }
  }
}

function scanFile(file) {
  const text = readFileSync(file, 'utf8');
  if (!RAW_TABLE_RE.test(text) || !TRANSACTIONS_TOKEN.test(text)) return;

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (ARITHMETIC_AMOUNT_RE.test(lines[i])) {
      const ctx = lines.slice(Math.max(0, i - 5), Math.min(lines.length, i + 2));
      if (ctx.some(l => RAW_TABLE_RE.test(l))) {
        findings.push({ file, line: i + 1, snippet: lines[i].trim() });
      }
    }
  }
}

walk(SRC_ROOT);

if (findings.length === 0) {
  console.log('No precision-sensitive arithmetic detected on raw_transactions ↔ transactions joins.');
  console.log('NUMERIC(15,2) on both sides remains symmetric — no action needed.');
  process.exit(0);
}

console.log(`Found ${findings.length} potential drift site(s):`);
console.log('');
for (const f of findings) {
  console.log(`${f.file}:${f.line}`);
  console.log(`  ${f.snippet}`);
}
console.log('');
console.log('Review whether these multiply/divide amounts across the join boundary.');
console.log('If so, the follow-up is to widen both sides (raw + transactions) to NUMERIC(18,4)');
console.log('in a single migration. Do not widen one side in isolation.');
