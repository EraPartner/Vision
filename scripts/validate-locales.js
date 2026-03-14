#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const src = path.join(repoRoot, 'i18n', 'source');
const frontendLocales = path.join(repoRoot, 'apps', 'frontend', 'src', 'locales');
const packagingI18n = path.join(repoRoot, 'packaging', 'electron', 'i18n');

function fail(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    fail(`Invalid JSON in ${filePath}: ${err.message}`);
  }
}

function parseGeneratedTs(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const out = {};
  if (content.includes('\\",\\n')) {
    fail(`Suspicious escaped fragment found in generated locale file ${filePath}. Regenerate locales from clean source.`);
  }
  const re = /^\s*'([^']+)':\s*'((?:\\.|[^'])*)',\s*$/gm;
  let match;
  while ((match = re.exec(content)) !== null) {
    const key = match[1];
    const val = match[2]
      .replace(/\\'/g, "'")
      .replace(/\\\\/g, '\\');
    out[key] = val;
  }
  return out;
}

function placeholderTokens(str) {
  const tokens = str.match(/\{[a-zA-Z0-9_]+\}/g);
  return new Set(tokens || []);
}

function sameSet(a, b) {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

if (!fs.existsSync(src)) {
  fail('No i18n/source directory found. Run generate-locales first.');
}

const files = fs.readdirSync(src).filter((f) => f.endsWith('.json')).sort();
if (!files.length) {
  fail('No locale source JSON files found in i18n/source.');
}

const masters = {};
for (const f of files) {
  const lang = path.basename(f, '.json');
  const fullPath = path.join(src, f);
  masters[lang] = readJson(fullPath);
}

if (!masters.en) {
  fail('English master (en.json) is required for parity checks.');
}

let failed = false;
const en = masters.en;
const enKeys = new Set(Object.keys(en));

for (const [lang, dict] of Object.entries(masters)) {
  const suspicious = Object.entries(dict).filter(([, v]) => typeof v === 'string' && /\\",\\n$/.test(v));
  if (suspicious.length) {
    console.error(`Language ${lang} has ${suspicious.length} suspicious escaped-tail strings (sample 20 keys):`);
    console.error(suspicious.slice(0, 20).map(([k]) => k).join('\n'));
    failed = true;
  }

  const keys = new Set(Object.keys(dict));

  if (lang !== 'en') {
    const missing = [...enKeys].filter((k) => !keys.has(k));
    if (missing.length) {
      console.error(`Language ${lang} is missing ${missing.length} keys (sample 20):`);
      console.error(missing.slice(0, 20).join('\n'));
      failed = true;
    }

    const extra = [...keys].filter((k) => !enKeys.has(k));
    if (extra.length) {
      console.error(`Language ${lang} has ${extra.length} extra keys not in en.json (sample 20):`);
      console.error(extra.slice(0, 20).join('\n'));
      failed = true;
    }
  }

  const nonString = Object.entries(dict).filter(([, v]) => typeof v !== 'string');
  if (nonString.length) {
    console.error(`Language ${lang} has ${nonString.length} non-string values (sample 20 keys):`);
    console.error(nonString.slice(0, 20).map(([k]) => k).join('\n'));
    failed = true;
  }

  if (lang !== 'en') {
    const mismatchPlaceholders = [];
    for (const key of enKeys) {
      if (!dict.hasOwnProperty(key)) continue;
      const enTokens = placeholderTokens(en[key]);
      const locTokens = placeholderTokens(dict[key]);
      if (!sameSet(enTokens, locTokens)) mismatchPlaceholders.push(key);
    }
    if (mismatchPlaceholders.length) {
      console.error(`Language ${lang} has ${mismatchPlaceholders.length} placeholder mismatches vs en (sample 20):`);
      console.error(mismatchPlaceholders.slice(0, 20).join('\n'));
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
    if (srcKeys.length !== outKeys.length || srcKeys.some((k, i) => k !== outKeys[i])) {
      console.error(`Frontend locale drift detected for ${lang}: key set mismatch with i18n/source/${lang}.json`);
      failed = true;
    } else {
      const diffValue = srcKeys.find((k) => dict[k] !== front[k]);
      if (diffValue) {
        console.error(`Frontend locale drift detected for ${lang}: value mismatch at key ${diffValue}`);
        failed = true;
      }
    }
  }

  if (!fs.existsSync(packagingPath)) {
    console.error(`Missing generated electron locale: ${packagingPath}`);
    failed = true;
  } else {
    const pkg = readJson(packagingPath);
    const srcKeys = Object.keys(dict).sort();
    const outKeys = Object.keys(pkg).sort();
    if (srcKeys.length !== outKeys.length || srcKeys.some((k, i) => k !== outKeys[i])) {
      console.error(`Electron locale drift detected for ${lang}: key set mismatch with i18n/source/${lang}.json`);
      failed = true;
    } else {
      const diffValue = srcKeys.find((k) => dict[k] !== pkg[k]);
      if (diffValue) {
        console.error(`Electron locale drift detected for ${lang}: value mismatch at key ${diffValue}`);
        failed = true;
      }
    }
  }
}

if (failed) {
  fail('Locale validation failed.', 2);
}

console.log('Locale validation passed: parity, placeholders, types, and generated-output drift checks are all clean.');
