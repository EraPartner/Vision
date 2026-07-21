#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const srcDir = path.join('i18n', 'source');
const enPath = path.join(srcDir, 'en.json');
const nlPath = path.join(srcDir, 'nl.json');

if (!fs.existsSync(enPath)) { console.error('Missing', enPath); process.exit(1); }
if (!fs.existsSync(nlPath)) { console.error('Missing', nlPath); process.exit(1); }

/** Parse a locale JSON file, failing with an actionable message on malformed input. */
function readLocale(p) {
  const raw = fs.readFileSync(p, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: ${p} is not valid JSON — ${err.message}`);
    console.error('Fix the syntax (e.g. a trailing comma or unescaped quote) and re-run.');
    process.exit(1);
  }
}

const en = readLocale(enPath);
const nl = readLocale(nlPath);

// Rebuild nl.json following en.json's key order, so keys stay in sync (new keys
// land in their en.json position rather than appended in encounter order). Keep
// each existing non-empty nl value; fall back to English for missing/empty ones.
let added = 0;
const synced = {};
for (const [k, v] of Object.entries(en)) {
  const existing = nl[k];
  if (existing !== undefined && existing !== null && existing !== '') {
    synced[k] = existing; // never overwrite a real Dutch translation
  } else {
    synced[k] = v; // fallback to English
    added++;
  }
}

// Prune orphaned nl keys no longer present in en.json, so parity is maintained
// (validate-locales enforces en/nl key parity; leaving orphans would break it).
const pruned = Object.keys(nl).filter((k) => !Object.prototype.hasOwnProperty.call(en, k));

fs.writeFileSync(nlPath, JSON.stringify(synced, null, 2) + '\n', 'utf8');
console.log(
  `Synced nl.json with en.json — added ${added} key(s) (fallback to English), `
  + `pruned ${pruned.length} orphan(s)${pruned.length ? `: ${pruned.join(', ')}` : ''}, `
  + 'keys ordered to match en.json.'
);
process.exit(0);
