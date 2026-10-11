#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

type LocaleSource = Record<string, unknown>;

const srcDir = path.join("i18n", "source");
const enPath = path.join(srcDir, "en.json");
const nlPath = path.join(srcDir, "nl.json");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? error.code
    : undefined;
}

function isLocaleSource(value: unknown): value is LocaleSource {
  return typeof value === "object" && value !== null;
}

/**
 * Read + parse a locale JSON file, failing with an actionable message. Reads
 * directly and handles a missing file via ENOENT rather than an existsSync
 * pre-check, so there is no check-then-use (TOCTOU) window on the path.
 */
function readLocale(p: string): LocaleSource {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf8");
  } catch (err) {
    console.error(
      errorCode(err) === "ENOENT"
        ? `Missing ${p}`
        : `ERROR: cannot read ${p} — ${errorMessage(err)}`,
    );
    process.exit(1);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(`ERROR: ${p} is not valid JSON — ${errorMessage(err)}`);
    console.error(
      "Fix the syntax (e.g. a trailing comma or unescaped quote) and re-run.",
    );
    process.exit(1);
  }
  if (!isLocaleSource(parsed)) {
    console.error(`ERROR: ${p} must contain a JSON object of locale strings`);
    process.exit(1);
  }
  return parsed;
}

const en = readLocale(enPath);
const nl = readLocale(nlPath);

// Rebuild nl.json following en.json's key order, so keys stay in sync (new keys
// land in their en.json position rather than appended in encounter order). Keep
// each existing non-empty nl value; fall back to English for missing/empty ones.
let added = 0;
const synced: LocaleSource = {};
for (const [k, v] of Object.entries(en)) {
  const existing = nl[k];
  if (existing !== undefined && existing !== null && existing !== "") {
    synced[k] = existing; // never overwrite a real Dutch translation
  } else {
    synced[k] = v; // fallback to English
    added++;
  }
}

// Prune orphaned nl keys no longer present in en.json, so parity is maintained
// (validate-locales enforces en/nl key parity; leaving orphans would break it).
const pruned = Object.keys(nl).filter(
  (k) => !Object.prototype.hasOwnProperty.call(en, k),
);

fs.writeFileSync(nlPath, JSON.stringify(synced, null, 2) + "\n", "utf8");
console.log(
  `Synced nl.json with en.json — added ${added} key(s) (fallback to English), ` +
    `pruned ${pruned.length} orphan(s)${pruned.length ? `: ${pruned.join(", ")}` : ""}, ` +
    "keys ordered to match en.json.",
);
process.exit(0);
