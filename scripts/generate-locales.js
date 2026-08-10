#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

// Strict single source of truth generator.
// Canonical inputs: i18n/source/*.json only.
// Generated outputs:
//   - apps/frontend/src/locales/<lang>.ts
//   - packaging/electron/i18n/<lang>.json

const repoRoot = path.resolve(__dirname, '..');
const frontendLocales = path.join(repoRoot, 'apps', 'frontend', 'src', 'locales');
const packagingI18n = path.join(repoRoot, 'packaging', 'electron', 'i18n');
const masterDir = path.join(repoRoot, 'i18n', 'source');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJSONStrict(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    throw new Error(`Invalid JSON at ${p}: ${e.message}`);
  }
}

// Normalize typographic characters to ASCII-friendly equivalents to avoid
// smart-quote induced parsing errors downstream. Operates on a single string.
function normalizeString(s) {
  if (s === null || s === undefined) return s;
  if (typeof s !== 'string') return s;
  return s
    .replace(/\u2018|\u2019|\u201B|\u2032/g, "'")
    .replace(/\u201C|\u201D|\u201F|\u2033/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/\u2013/g, '-')
    // U+2014 (em dash) is intentionally preserved: it is real UI typography,
    // not a smart-quote parse hazard, and downstream (TS/JSON) carry it fine.
    .replace(/\u00A0/g, ' ')
    // U+00B7 (middle dot) is preserved for the same reason as the em dash. It
    // is the clause separator in strings like "Enter to send \u00B7 Shift+Enter";
    // folding it to "." produced a stray spaced period (" . ") that reads as a
    // rendering bug, and silently reverted any source-level fix.
    .replace(/\u2010|\u2011/g, '-')
    .replace(/\u2039|\u203A/g, '<>')
    .replace(/\u00AB|\u00BB/g, '"');
}

function writeFrontendTs(lang, obj) {
  const p = path.join(frontendLocales, `${lang}.ts`);
  ensureDir(frontendLocales);
  const header = `// Auto-generated - do not edit manually. Edit i18n/source/${lang}.json instead.\n`;
  const lines = [header, `const ${lang}: Record<string, string> = {`];
  const keys = Object.keys(obj).sort();
  for (const k of keys) {
    // Escape backslashes, newlines, carriage returns, tabs and single quotes
    // so the generated TypeScript file remains a valid single-line string literal.
    let v = obj[k];
    v = v.replace(/\\/g, '\\\\')
         .replace(/\n/g, '\\n')
         .replace(/\r/g, '\\r')
         .replace(/\t/g, '\\t')
         .replace(/'/g, "\\'");
    lines.push(`  '${k}': '${v}',`);
  }
  lines.push('};', `export default ${lang};`, '');
  fs.writeFileSync(p, lines.join('\n'), 'utf8');
}

function writePackagingJson(lang, obj) {
  ensureDir(packagingI18n);
  const p = path.join(packagingI18n, `${lang}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function writeMasterJson(lang, obj) {
  ensureDir(masterDir);
  const p = path.join(masterDir, `${lang}.json`);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function getLanguages() {
  ensureDir(masterDir);
  const langs = fs
    .readdirSync(masterDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.basename(name, '.json'));

  return langs.sort((a, b) => {
    if (a === 'en') return -1;
    if (b === 'en') return 1;
    return a.localeCompare(b);
  });
}

function normalizeObject(obj) {
  const out = {};
  for (const key of Object.keys(obj).sort()) {
    const value = obj[key];
    out[key] = typeof value === 'string' ? normalizeString(value) : value;
  }
  return out;
}

function validateLocaleObject(lang, obj) {
  const invalid = Object.entries(obj).filter(([, v]) => typeof v !== 'string');
  if (invalid.length) {
    throw new Error(`Locale ${lang} has ${invalid.length} non-string values. Fix i18n/source/${lang}.json`);
  }
}

function run() {
  const languages = getLanguages();
  if (!languages.length) {
    console.error('No locale source files found in i18n/source/*.json');
    process.exit(1);
  }

  const sanitizeOnly = process.argv.includes('--sanitize-only');
  if (sanitizeOnly) {
    console.log('Sanitize-only mode: normalizing i18n/source JSON masters...');
    let totalChanged = 0;
    for (const lang of languages) {
      const p = path.join(masterDir, `${lang}.json`);
      let obj;
      try {
        obj = readJSONStrict(p);
      } catch {
        continue;
      }
      let changed = 0;
      for (const k of Object.keys(obj)) {
        const v = obj[k];
        if (typeof v === 'string') {
          const nv = normalizeString(v);
          if (nv !== v) {
            obj[k] = nv;
            changed++;
          }
        }
      }
      if (changed) {
        fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
        console.log(` - ${lang}: normalized ${changed} strings`);
      }
      totalChanged += changed;
    }
    console.log(`Sanitize completed. Total normalized strings: ${totalChanged}`);
    process.exit(0);
  }

  console.log('Generating locales from sources...');
  for (const lang of languages) {
    const masterPath = path.join(masterDir, `${lang}.json`);
    const source = readJSONStrict(masterPath);
    const finalMaster = normalizeObject(source);

    validateLocaleObject(lang, finalMaster);

    // Persist normalized source for deterministic diffs.
    writeMasterJson(lang, finalMaster);
    writeFrontendTs(lang, finalMaster);
    writePackagingJson(lang, finalMaster);

    console.log(` - ${lang}: keys=${Object.keys(finalMaster).length}`);
  }
  console.log('Locales generated from i18n/source to frontend and packaging outputs.');
}

try {
  run();
} catch (err) {
  console.error(err.message || String(err));
  process.exit(1);
}
