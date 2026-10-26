#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

import { extractTranslationCalls } from "./lib/localeCallParser.ts";

type LocaleSource = Record<string, unknown>;

const repoRoot = path.resolve(import.meta.dirname, "..");
const src = path.join(repoRoot, "i18n", "source");
const frontendLocales = path.join(
  repoRoot,
  "apps",
  "frontend",
  "src",
  "locales",
);
const packagingI18n = path.join(repoRoot, "packaging", "electron", "i18n");

function fail(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

function isLocaleSource(value: unknown): value is LocaleSource {
  return typeof value === "object" && value !== null;
}

function hasOwn(object: LocaleSource, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function readJson(filePath: string): LocaleSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    fail(
      `Invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!isLocaleSource(parsed)) {
    fail(`Invalid JSON in ${filePath}: expected an object of locale strings`);
  }
  return parsed;
}

function parseGeneratedTs(filePath: string): Record<string, string> {
  const content = fs.readFileSync(filePath, "utf8");
  const out: Record<string, string> = {};
  if (content.includes('\\",\\n')) {
    fail(
      `Suspicious escaped fragment found in generated locale file ${filePath}. Regenerate locales from clean source.`,
    );
  }
  // Anchored single-line regex: no alternation under a quantifier, so backtracking
  // stays linear (avoids the ReDoS pattern CodeQL flagged on the multiline form).
  const lineRe = /^\s*'([^']+)':\s*'(.*)',\s*$/;
  for (const line of content.split("\n")) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const key = match[1] ?? "";
    const raw = match[2] ?? "";
    let val = "";
    for (let i = 0; i < raw.length; i++) {
      const ch = raw.charAt(i);
      if (ch !== "\\" || i === raw.length - 1) {
        val += ch;
        continue;
      }
      const next = raw.charAt(++i);
      switch (next) {
        case "n":
          val += "\n";
          break;
        case "r":
          val += "\r";
          break;
        case "t":
          val += "\t";
          break;
        case "'":
          val += "'";
          break;
        case '"':
          val += '"';
          break;
        case "\\":
          val += "\\";
          break;
        default:
          val += next;
      }
    }
    out[key] = val;
  }
  return out;
}

function placeholderTokens(str: unknown): Set<string> {
  // Non-string values are reported by the type check below; they have no tokens.
  if (typeof str !== "string") return new Set();
  const tokens = str.match(/\{[a-zA-Z0-9_]+\}/g);
  return new Set(tokens ?? []);
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

if (!fs.existsSync(src)) {
  fail("No i18n/source directory found. Run generate-locales first.");
}

const files = fs
  .readdirSync(src)
  .filter((f) => f.endsWith(".json"))
  .sort();
if (files.length === 0) {
  fail("No locale source JSON files found in i18n/source.");
}

const masters: Record<string, LocaleSource> = {};
for (const f of files) {
  const lang = path.basename(f, ".json");
  const fullPath = path.join(src, f);
  masters[lang] = readJson(fullPath);
}

const en =
  masters.en ?? fail("English master (en.json) is required for parity checks.");

let failed = false;
const enKeys = new Set(Object.keys(en));

// A value starting with a bracketed language-code stub (e.g. "[NL] ...") means a
// translation was never done and the placeholder is about to ship verbatim to users.
const STUB_PREFIX_RE = /^\[[A-Z]{2}\]\s/;

for (const [lang, dict] of Object.entries(masters)) {
  const suspicious = Object.entries(dict).filter(
    ([, v]) => typeof v === "string" && /\\",\\n$/.test(v),
  );
  if (suspicious.length > 0) {
    console.error(
      `Language ${lang} has ${suspicious.length} suspicious escaped-tail strings (sample 20 keys):`,
    );
    console.error(
      suspicious
        .slice(0, 20)
        .map(([k]) => k)
        .join("\n"),
    );
    failed = true;
  }

  const stubbed = Object.entries(dict).filter(
    ([, v]) => typeof v === "string" && STUB_PREFIX_RE.test(v),
  );
  if (stubbed.length > 0) {
    console.error(
      `Language ${lang} has ${stubbed.length} untranslated stub value(s) still prefixed with a "[XX] " placeholder (sample 20 keys):`,
    );
    console.error(
      stubbed
        .slice(0, 20)
        .map(([k]) => k)
        .join("\n"),
    );
    failed = true;
  }

  const keys = new Set(Object.keys(dict));

  if (lang !== "en") {
    const missing = [...enKeys].filter((k) => !keys.has(k));
    if (missing.length > 0) {
      console.error(
        `Language ${lang} is missing ${missing.length} keys (sample 20):`,
      );
      console.error(missing.slice(0, 20).join("\n"));
      failed = true;
    }

    const extra = [...keys].filter((k) => !enKeys.has(k));
    if (extra.length > 0) {
      console.error(
        `Language ${lang} has ${extra.length} extra keys not in en.json (sample 20):`,
      );
      console.error(extra.slice(0, 20).join("\n"));
      failed = true;
    }
  }

  const nonString = Object.entries(dict).filter(
    ([, v]) => typeof v !== "string",
  );
  if (nonString.length > 0) {
    console.error(
      `Language ${lang} has ${nonString.length} non-string values (sample 20 keys):`,
    );
    console.error(
      nonString
        .slice(0, 20)
        .map(([k]) => k)
        .join("\n"),
    );
    failed = true;
  }

  if (lang !== "en") {
    const mismatchPlaceholders: string[] = [];
    for (const key of enKeys) {
      if (!hasOwn(dict, key)) continue;
      const enTokens = placeholderTokens(en[key]);
      const locTokens = placeholderTokens(dict[key]);
      if (!sameSet(enTokens, locTokens)) mismatchPlaceholders.push(key);
    }
    if (mismatchPlaceholders.length > 0) {
      console.error(
        `Language ${lang} has ${mismatchPlaceholders.length} placeholder mismatches vs en (sample 20):`,
      );
      console.error(mismatchPlaceholders.slice(0, 20).join("\n"));
      failed = true;
    }
  }
}

// Drift checks: generated outputs must exactly match i18n/source content.
for (const [lang, dict] of Object.entries(masters)) {
  const frontendPath = path.join(frontendLocales, `${lang}.ts`);
  const packagingPath = path.join(packagingI18n, `${lang}.json`);

  if (!fs.existsSync(frontendPath)) {
    console.error(`Missing generated frontend locale: ${frontendPath}`);
    failed = true;
  } else {
    const front = parseGeneratedTs(frontendPath);
    const srcKeys = Object.keys(dict).sort();
    const outKeys = Object.keys(front).sort();
    if (
      srcKeys.length !== outKeys.length ||
      srcKeys.some((k, i) => k !== outKeys[i])
    ) {
      console.error(
        `Frontend locale drift detected for ${lang}: key set mismatch with i18n/source/${lang}.json`,
      );
      failed = true;
    } else {
      const diffValue = srcKeys.find((k) => dict[k] !== front[k]);
      if (diffValue) {
        console.error(
          `Frontend locale drift detected for ${lang}: value mismatch at key ${diffValue}`,
        );
        failed = true;
      }
    }
  }

  if (!fs.existsSync(packagingPath)) {
    // The electron i18n JSON is a build-time output of generate-locales.ts and is
    // no longer tracked (SIMP-25); it is regenerated on `electron start`/`dist`.
    // Only enforce drift when a copy is present on disk.
  } else {
    const pkg = readJson(packagingPath);
    const srcKeys = Object.keys(dict).sort();
    const outKeys = Object.keys(pkg).sort();
    if (
      srcKeys.length !== outKeys.length ||
      srcKeys.some((k, i) => k !== outKeys[i])
    ) {
      console.error(
        `Generated Electron locale packaging/electron/i18n/${lang}.json is stale: key set mismatch with i18n/source/${lang}.json. Run \`bun run generate-locales\` to regenerate it.`,
      );
      failed = true;
    } else {
      const diffValue = srcKeys.find((k) => dict[k] !== pkg[k]);
      if (diffValue) {
        console.error(
          `Generated Electron locale packaging/electron/i18n/${lang}.json is stale: value mismatch at key ${diffValue}. Run \`bun run generate-locales\` to regenerate it.`,
        );
        failed = true;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Source-usage checks. parseGeneratedTs/parity/drift only compare locale files
// to each other; they cannot see how the code calls t()/tc(). These three
// guards close the leak classes that slip past:
//   1. key-existence  — t('a.b.c') for a key absent from en renders the raw key
//   2. value-shape    — a locale value that is itself a dotted key (paste error)
//   3. dropped-vars   — t('k', { x }) where the string has no {x} drops x silently
// ---------------------------------------------------------------------------
const frontendSrc = path.join(repoRoot, "apps", "frontend", "src");
// i18n keys are dotted identifiers with no spaces/braces: word.subword.subsub.
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+$/;
const PLURAL_CATS = ["", ".zero", ".one", ".two", ".few", ".many", ".other"];

function walkSources(dir: string, acc: string[]): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === "node_modules" ||
      entry.name === "locales" ||
      entry.name === "__tests__"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, acc);
    else if (
      /\.(ts|tsx)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts") &&
      !/\.test\.tsx?$/.test(entry.name)
    )
      acc.push(full);
  }
  return acc;
}

function placeholdersFor(key: string): {
  exists: boolean;
  tokens: Set<string>;
} {
  const set = new Set<string>();
  let exists = false;
  for (const cat of PLURAL_CATS) {
    const v = en[key + cat];
    if (typeof v === "string") {
      exists = true;
      for (const t of placeholderTokens(v)) set.add(t);
    }
  }
  return { exists, tokens: set };
}

if (fs.existsSync(frontendSrc)) {
  const missingKeys: string[] = [];
  const droppedVars: string[] = [];
  for (const file of walkSources(frontendSrc, [])) {
    const code = fs.readFileSync(file, "utf8");
    const rel = path.relative(repoRoot, file);
    for (const { fn, key, line, variableNames } of extractTranslationCalls(
      code,
      file,
    )) {
      if (!KEY_SHAPE.test(key)) continue; // not an i18n key reference
      const { exists, tokens } = placeholdersFor(key);
      if (!exists) {
        missingKeys.push(`${rel}:${line}  ${fn}('${key}')`);
        continue;
      }
      if (variableNames === null) continue; // no vars, or a dynamic object/variable
      const allowed = new Set([...tokens].map((t) => t.slice(1, -1)));
      if (fn === "tc") allowed.add("count");
      const dropped = variableNames.filter((name) => !allowed.has(name));
      const enValue = en[key] ?? en[key + ".other"];
      const sample = typeof enValue === "string" ? enValue : "";
      if (dropped.length > 0)
        droppedVars.push(
          `${rel}:${line}  ${fn}('${key}') drops {${dropped.join("}, {")}} (string: "${sample}")`,
        );
    }
  }
  if (missingKeys.length > 0) {
    console.error(
      `Found ${missingKeys.length} t()/tc() call(s) referencing keys absent from en.json (the raw key would render):`,
    );
    console.error(missingKeys.join("\n"));
    failed = true;
  }
  if (droppedVars.length > 0) {
    console.error(
      `Found ${droppedVars.length} t()/tc() call(s) passing a var with no matching {placeholder} (value is silently dropped):`,
    );
    console.error(droppedVars.join("\n"));
    failed = true;
  }

  // Value-shape: a locale value that is itself a dotted key is an untranslated leak.
  for (const [lang, dict] of Object.entries(masters)) {
    const keyish = Object.entries(dict).filter(
      ([, v]) => typeof v === "string" && KEY_SHAPE.test(v.trim()),
    );
    if (keyish.length > 0) {
      console.error(
        `Language ${lang} has ${keyish.length} value(s) shaped like an i18n key (likely an untranslated key pasted as a value):`,
      );
      console.error(
        keyish
          .slice(0, 20)
          .map(([k, v]) => `${k} = "${String(v)}"`)
          .join("\n"),
      );
      failed = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Unused-key pass (SIMP-47). The parity/drift checks above only compare locale
// files to each other; nothing catches keys that are defined but referenced
// nowhere in code, so dead keys accrue silently. A key counts as "used" if its
// dotted string appears anywhere in the non-locale source tree (statically,
// via a variable/JSON, or in the backend), OR it is reachable through a dynamic
// key prefix (t(`accounts.type.${x}`)) or the electron `app.*` allowlist. The
// Exact static matching plus conservative dynamic-prefix inference errs toward
// keeping ambiguous keys; the validator never deletes locale data itself.
// ---------------------------------------------------------------------------
const USAGE_SCAN_DIRS = ["apps", "packaging", "scripts", "packages", "config"];
const USAGE_EXTS = /\.(ts|tsx|js|jsx|cjs|mjs|json|html|sh|mako|yml|yaml)$/;
// Prefixes for keys consumed dynamically outside t()/tc() (e.g. the electron shell).
const DYNAMIC_KEY_ALLOWLIST = ["app."];
// A dotted-key prefix ending at a dot boundary (e.g. "accounts.type.").
const KEY_PREFIX = /([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.)$/;

function collectSourceText(
  dir: string,
  skipAbs: ReadonlySet<string>,
  acc: string[],
): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name === "build" ||
      entry.name === "coverage"
    )
      continue;
    const full = path.join(dir, entry.name);
    if (skipAbs.has(full)) continue;
    if (entry.isDirectory()) collectSourceText(full, skipAbs, acc);
    else if (USAGE_EXTS.test(entry.name)) {
      try {
        acc.push(fs.readFileSync(full, "utf8"));
      } catch {
        /* ignore unreadable */
      }
    }
  }
  return acc;
}

// Skip the locale files themselves (they define every key, so they'd mark all "used").
const usageSkip = new Set([frontendLocales, packagingI18n]);
const usageChunks: string[] = [];
for (const d of USAGE_SCAN_DIRS)
  collectSourceText(path.join(repoRoot, d), usageSkip, usageChunks);
const haystack = usageChunks.join("\n");

// Dynamic prefixes: literal segment before the first `${` in a template literal,
// and the literal segment before a `+` string concatenation.
const dynamicPrefixes = new Set<string>(DYNAMIC_KEY_ALLOWLIST);
const tplRe = /`([^`\\]*)\$\{/g;
let tpm: RegExpExecArray | null;
while ((tpm = tplRe.exec(haystack))) {
  const lead = (tpm[1] ?? "").match(KEY_PREFIX);
  if (lead?.[1]) dynamicPrefixes.add(lead[1]);
}
const concatRe = /['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.)['"]\s*\+/g;
let ccm: RegExpExecArray | null;
while ((ccm = concatRe.exec(haystack))) {
  if (ccm[1]) dynamicPrefixes.add(ccm[1]);
}

// Exact-match index: every maximal run of key-shaped characters (letters,
// digits, underscore, dot) in the haystack, as its own set entry. A dotted key
// is only "referenced" if the FULL identifier it appears in equals the key —
// e.g. `t('plannedForm.nameRequired2')` contributes the run
// "plannedForm.nameRequired2", not also its prefix "plannedForm.nameRequired".
// Delimiters (quotes, parens, commas, whitespace, backticks, ...) are exactly
// what falls outside this character class, so quotes/template-literal
// boundaries/`t('key')` calls all fall out for free — no per-key regex needed,
// which also keeps this a single O(haystack) pass instead of O(keys × haystack).
const KEY_CHAR_RUN_RE = /[A-Za-z0-9_.]+/g;
const usedIdentifiers = new Set<string>();
let idm: RegExpExecArray | null;
while ((idm = KEY_CHAR_RUN_RE.exec(haystack))) usedIdentifiers.add(idm[0]);

function keyIsUsed(key: string): boolean {
  for (const p of dynamicPrefixes) if (key.startsWith(p)) return true;
  if (usedIdentifiers.has(key)) return true;
  // Plural variants: a live `tc('x')` only mentions the base key, not x.one/x.other.
  const base = key.replace(/\.(zero|one|two|few|many|other)$/, "");
  if (base !== key) {
    for (const p of dynamicPrefixes) if (base.startsWith(p)) return true;
    if (usedIdentifiers.has(base)) return true;
  }
  return false;
}

const unusedKeys = [...enKeys].filter((k) => !keyIsUsed(k));

if (process.argv.includes("--list-unused")) {
  process.stdout.write(
    unusedKeys.sort().join("\n") + (unusedKeys.length > 0 ? "\n" : ""),
  );
  process.exit(0);
}

if (unusedKeys.length > 0) {
  console.error(
    `Found ${unusedKeys.length} i18n key(s) defined in en.json but referenced nowhere in ${USAGE_SCAN_DIRS.join("/")}:`,
  );
  console.error(unusedKeys.slice(0, 40).join("\n"));
  if (unusedKeys.length > 40)
    console.error(
      `... and ${unusedKeys.length - 40} more. Run \`bun scripts/validate-locales.ts --list-unused\` for the full list.`,
    );
  failed = true;
}

if (failed) {
  fail("Locale validation failed.", 2);
}

console.log(
  "Locale validation passed: parity, placeholders, types, source key-usage, unused-key, and generated-output drift checks are all clean.",
);
