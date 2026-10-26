#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";

// Strict single source of truth generator.
// Canonical inputs: i18n/source/*.json only.
// Generated outputs:
//   - apps/frontend/src/locales/<lang>.ts
//   - apps/frontend/src/locales/keys.ts (type-only key unions derived from en)
//   - packaging/electron/i18n/<lang>.json

type LocaleSource = Record<string, unknown>;
type LocaleStrings = Record<string, string>;

const repoRoot = path.resolve(import.meta.dirname, "..");
const frontendLocales = path.join(
  repoRoot,
  "apps",
  "frontend",
  "src",
  "locales",
);
const packagingI18n = path.join(repoRoot, "packaging", "electron", "i18n");
const masterDir = path.join(repoRoot, "i18n", "source");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSONStrict(p: string): LocaleSource {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    throw new Error(`Invalid JSON at ${p}: ${errorMessage(e)}`);
  }
  if (!isLocaleSource(parsed)) {
    throw new Error(`Invalid JSON at ${p}: expected an object of strings`);
  }
  return parsed;
}

function isLocaleSource(value: unknown): value is LocaleSource {
  return typeof value === "object" && value !== null;
}

// Normalize smart quotes and dash variants that can create inconsistent source
// text. Preserve intentional UI typography such as ellipses and em dashes;
// TypeScript and JSON carry those characters without parsing ambiguity.
function normalizeString(s: string): string {
  return (
    s
      .replace(/‘|’|‛|′/g, "'")
      .replace(/“|”|‟|″/g, '"')
      .replace(/–/g, "-")
      // U+2014 (em dash) is intentionally preserved: it is real UI typography,
      // not a smart-quote parse hazard, and downstream (TS/JSON) carry it fine.
      .replace(/ /g, " ")
      // U+00B7 (middle dot) is preserved for the same reason as the em dash. It
      // is the clause separator in strings like "Enter to send · Shift+Enter";
      // folding it to "." produced a stray spaced period (" . ") that reads as a
      // rendering bug, and silently reverted any source-level fix.
      .replace(/‐|‑/g, "-")
      .replace(/‹|›/g, "<>")
      .replace(/«|»/g, '"')
  );
}

function writeFrontendTs(lang: string, obj: LocaleStrings): void {
  const p = path.join(frontendLocales, `${lang}.ts`);
  ensureDir(frontendLocales);
  const header = `// Auto-generated - do not edit manually. Edit i18n/source/${lang}.json instead.\n`;
  const lines = [header, `const ${lang}: Record<string, string> = {`];
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    // Escape backslashes, newlines, carriage returns, tabs and single quotes
    // so the generated TypeScript file remains a valid single-line string literal.
    const v = (obj[k] ?? "")
      .replace(/\\/g, "\\\\")
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r")
      .replace(/\t/g, "\\t")
      .replace(/'/g, "\\'");
    lines.push(`  '${k}': '${v}',`);
  }
  lines.push("};", `export default ${lang};`, "");
  fs.writeFileSync(p, lines.join("\n"), "utf8");
}

// Type-only module: the union of English keys, so `t("typo")` fails to compile
// without the app importing the (lazily loaded) en dictionary at runtime.
// PluralTranslationKey holds the bases accepted by `tc`: every key base with a
// `.other` variant (the CLDR fallback tc resolves).
function writeKeysTs(obj: LocaleStrings): void {
  const p = path.join(frontendLocales, "keys.ts");
  ensureDir(frontendLocales);
  const keys = Object.keys(obj).sort();
  const quote = (k: string) => JSON.stringify(k);
  const bases = new Set<string>();
  for (const k of keys) {
    if (k.endsWith(".other")) bases.add(k.slice(0, -".other".length));
  }
  const lines = [
    `// Auto-generated - do not edit manually. Edit i18n/source/en.json instead.\n`,
    `/** Every translation key present in the English source. */`,
    `export type TranslationKey =`,
    ...keys.map((k) => `  | ${quote(k)}`),
    `  ;`,
    ``,
    `/** Bases accepted by \`tc\`: keys with a \`.other\` plural variant. */`,
    `export type PluralTranslationKey =`,
    ...[...bases].sort().map((k) => `  | ${quote(k)}`),
    `  ;`,
    ``,
  ];
  fs.writeFileSync(p, lines.join("\n"), "utf8");
}

function writePackagingJson(lang: string, obj: LocaleStrings): void {
  ensureDir(packagingI18n);
  const p = path.join(packagingI18n, `${lang}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function writeMasterJson(lang: string, obj: LocaleStrings): void {
  ensureDir(masterDir);
  const p = path.join(masterDir, `${lang}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function getLanguages(): string[] {
  ensureDir(masterDir);
  const langs = fs
    .readdirSync(masterDir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.basename(name, ".json"));

  return langs.sort((a, b) => {
    if (a === "en") return -1;
    if (b === "en") return 1;
    return a.localeCompare(b);
  });
}

function normalizeObject(obj: LocaleSource): LocaleSource {
  const out: LocaleSource = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    out[key] = typeof value === "string" ? normalizeString(value) : value;
  }
  return out;
}

function validateLocaleObject(
  lang: string,
  obj: LocaleSource,
): asserts obj is LocaleStrings {
  const invalid = Object.entries(obj).filter(([, v]) => typeof v !== "string");
  if (invalid.length > 0) {
    throw new Error(
      `Locale ${lang} has ${invalid.length} non-string values. Fix i18n/source/${lang}.json`,
    );
  }
}

function run(): void {
  const languages = getLanguages();
  if (languages.length === 0) {
    console.error("No locale source files found in i18n/source/*.json");
    process.exit(1);
  }

  const sanitizeOnly = process.argv.includes("--sanitize-only");
  if (sanitizeOnly) {
    console.log("Sanitize-only mode: normalizing i18n/source JSON masters...");
    let totalChanged = 0;
    for (const lang of languages) {
      const p = path.join(masterDir, `${lang}.json`);
      let obj: LocaleSource;
      try {
        obj = readJSONStrict(p);
      } catch {
        continue;
      }
      let changed = 0;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === "string") {
          const nv = normalizeString(v);
          if (nv !== v) {
            obj[k] = nv;
            changed++;
          }
        }
      }
      if (changed > 0) {
        fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
        console.log(` - ${lang}: normalized ${changed} strings`);
      }
      totalChanged += changed;
    }
    console.log(
      `Sanitize completed. Total normalized strings: ${totalChanged}`,
    );
    process.exit(0);
  }

  console.log("Generating locales from sources...");
  for (const lang of languages) {
    const masterPath = path.join(masterDir, `${lang}.json`);
    const source = readJSONStrict(masterPath);
    const finalMaster = normalizeObject(source);

    validateLocaleObject(lang, finalMaster);

    // Persist normalized source for deterministic diffs.
    writeMasterJson(lang, finalMaster);
    writeFrontendTs(lang, finalMaster);
    writePackagingJson(lang, finalMaster);
    if (lang === "en") writeKeysTs(finalMaster);

    console.log(` - ${lang}: keys=${Object.keys(finalMaster).length}`);
  }
  console.log(
    "Locales generated from i18n/source to frontend and packaging outputs.",
  );
}

try {
  run();
} catch (err) {
  console.error(errorMessage(err));
  process.exit(1);
}
