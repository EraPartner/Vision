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
  // Anchored single-line regex: no alternation under a quantifier, so backtracking
  // stays linear (avoids the ReDoS pattern CodeQL flagged on the multiline form).
  const lineRe = /^\s*'([^']+)':\s*'(.*)',\s*$/;
  for (const line of content.split('\n')) {
    const match = lineRe.exec(line);
    if (!match) continue;
    const key = match[1];
    const raw = match[2];
    let val = '';
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch !== '\\' || i === raw.length - 1) {
        val += ch;
        continue;
      }
      const next = raw[++i];
      switch (next) {
        case 'n': val += '\n'; break;
        case 'r': val += '\r'; break;
        case 't': val += '\t'; break;
        case "'": val += "'"; break;
        case '"': val += '"'; break;
        case '\\': val += '\\'; break;
        default: val += next;
      }
    }
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

// A value starting with a bracketed language-code stub (e.g. "[NL] ...") means a
// translation was never done and the placeholder is about to ship verbatim to users.
const STUB_PREFIX_RE = /^\[[A-Z]{2}\]\s/;

for (const [lang, dict] of Object.entries(masters)) {
  const suspicious = Object.entries(dict).filter(([, v]) => typeof v === 'string' && /\\",\\n$/.test(v));
  if (suspicious.length) {
    console.error(`Language ${lang} has ${suspicious.length} suspicious escaped-tail strings (sample 20 keys):`);
    console.error(suspicious.slice(0, 20).map(([k]) => k).join('\n'));
    failed = true;
  }

  const stubbed = Object.entries(dict).filter(([, v]) => typeof v === 'string' && STUB_PREFIX_RE.test(v));
  if (stubbed.length) {
    console.error(`Language ${lang} has ${stubbed.length} untranslated stub value(s) still prefixed with a "[XX] " placeholder (sample 20 keys):`);
    console.error(stubbed.slice(0, 20).map(([k]) => k).join('\n'));
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
    // The electron i18n JSON is a build-time output of generate-locales.js and is
    // no longer tracked (SIMP-25); it is regenerated on `electron start`/`dist`.
    // Only enforce drift when a copy is present on disk.
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

// ---------------------------------------------------------------------------
// Source-usage checks. parseGeneratedTs/parity/drift only compare locale files
// to each other; they cannot see how the code calls t()/tc(). These three
// guards close the leak classes that slip past:
//   1. key-existence  — t('a.b.c') for a key absent from en renders the raw key
//   2. value-shape    — a locale value that is itself a dotted key (paste error)
//   3. dropped-vars   — t('k', { x }) where the string has no {x} drops x silently
// ---------------------------------------------------------------------------
const frontendSrc = path.join(repoRoot, 'apps', 'frontend', 'src');
// i18n keys are dotted identifiers with no spaces/braces: word.subword.subsub.
const KEY_SHAPE = /^[a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)+$/;
const PLURAL_CATS = ['', '.zero', '.one', '.two', '.few', '.many', '.other'];

// Blank out // and /* */ comments while preserving offsets and newlines, so
// line numbers stay accurate and key-shaped literals inside JSDoc examples
// (e.g. the t('col.date') in a usage comment) are not mistaken for real calls.
function blankComments(code) {
  let out = '';
  let str = null;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    const c2 = code[i + 1];
    if (str) {
      out += c;
      if (c === '\\') { out += code[i + 1] ?? ''; i++; }
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; out += c; continue; }
    if (c === '/' && c2 === '/') { while (i < code.length && code[i] !== '\n') { out += ' '; i++; } i--; continue; }
    if (c === '/' && c2 === '*') {
      out += '  '; i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) { out += code[i] === '\n' ? '\n' : ' '; i++; }
      out += '  '; i++;
      continue;
    }
    out += c;
  }
  return out;
}

function readStringLiteral(s, i) {
  const q = s[i];
  if (q !== '"' && q !== "'" && q !== '`') return undefined;
  let val = '';
  let dynamic = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { val += s[j + 1]; j++; continue; }
    if (q === '`' && c === '$' && s[j + 1] === '{') dynamic = true;
    if (c === q) return { value: val, end: j, dynamic };
    val += c;
  }
  return undefined;
}

// From just after '(', split the argument list at top-level commas.
function readArgs(s, i) {
  let depth = 1;
  let cur = '';
  let str = null;
  const args = [];
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (str) {
      cur += c;
      if (c === '\\') { cur += s[j + 1] ?? ''; j++; }
      else if (c === str) str = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { str = c; cur += c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(cur); break; }
    }
    if (depth === 1 && c === ',') { args.push(cur); cur = ''; continue; }
    cur += c;
  }
  return args;
}

// Top-level keys of an object literal; returns undefined for spreads/variables.
function objectKeys(raw) {
  const s = raw.trim();
  if (!s.startsWith('{')) return undefined;
  const body = s.slice(1, s.lastIndexOf('}'));
  const keys = [];
  let depth = 0;
  let str = null;
  let expectKey = true;
  let ident = '';
  const flush = () => { const id = ident.trim(); if (/^[A-Za-z_$][\w$]*$/.test(id)) keys.push(id); ident = ''; };
  for (let j = 0; j < body.length; j++) {
    const c = body[j];
    if (str) { if (c === '\\') j++; else if (c === str) str = null; continue; }
    if (c === '"' || c === "'" || c === '`') {
      if (depth === 0 && expectKey) {
        const lit = readStringLiteral(body, j);
        if (lit && !lit.dynamic) { keys.push(lit.value); j = lit.end; expectKey = false; ident = ''; continue; }
      }
      str = c; continue;
    }
    if (c === '(' || c === '[' || c === '{') { depth++; continue; }
    if (c === ')' || c === ']' || c === '}') { depth--; continue; }
    if (depth === 0) {
      if (c === ':') { flush(); expectKey = false; continue; }
      if (c === ',') { if (expectKey) flush(); ident = ''; expectKey = true; continue; }
      ident += c;
    }
  }
  if (expectKey) flush();
  return keys;
}

function walkSources(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'locales' || entry.name === '__tests__') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkSources(full, acc);
    else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts') && !/\.test\.tsx?$/.test(entry.name)) acc.push(full);
  }
  return acc;
}

function placeholdersFor(key) {
  const set = new Set();
  let exists = false;
  for (const cat of PLURAL_CATS) {
    const v = en[key + cat];
    if (typeof v === 'string') { exists = true; for (const t of placeholderTokens(v)) set.add(t); }
  }
  return { exists, tokens: set };
}

if (fs.existsSync(frontendSrc)) {
  const missingKeys = [];
  const droppedVars = [];
  const callRe = /(?<![\w$.])(t|tc)\s*\(/g;
  for (const file of walkSources(frontendSrc, [])) {
    const code = blankComments(fs.readFileSync(file, 'utf8'));
    const rel = path.relative(repoRoot, file);
    let m;
    while ((m = callRe.exec(code))) {
      const fn = m[1];
      const args = readArgs(code, m.index + m[0].length);
      if (!args.length) continue;
      const arg0 = args[0].trim();
      const lit = readStringLiteral(arg0, 0);
      if (!lit || lit.dynamic || lit.end !== arg0.length - 1) continue; // dynamic/computed key
      const key = lit.value;
      if (!KEY_SHAPE.test(key)) continue; // not an i18n key reference
      const line = code.slice(0, m.index).split('\n').length;
      const { exists, tokens } = placeholdersFor(key);
      if (!exists) { missingKeys.push(`${rel}:${line}  ${fn}('${key}')`); continue; }
      const varsRaw = fn === 't' ? args[1] : args[2];
      if (varsRaw == null) continue;
      const passed = objectKeys(varsRaw);
      if (passed === undefined) continue; // spread / variable vars
      const allowed = new Set([...tokens].map((t) => t.slice(1, -1)));
      if (fn === 'tc') allowed.add('count');
      const dropped = passed.filter((p) => !allowed.has(p));
      if (dropped.length) droppedVars.push(`${rel}:${line}  ${fn}('${key}') drops {${dropped.join('}, {')}} (string: "${en[key] ?? en[key + '.other'] ?? ''}")`);
    }
  }
  if (missingKeys.length) {
    console.error(`Found ${missingKeys.length} t()/tc() call(s) referencing keys absent from en.json (the raw key would render):`);
    console.error(missingKeys.join('\n'));
    failed = true;
  }
  if (droppedVars.length) {
    console.error(`Found ${droppedVars.length} t()/tc() call(s) passing a var with no matching {placeholder} (value is silently dropped):`);
    console.error(droppedVars.join('\n'));
    failed = true;
  }

  // Value-shape: a locale value that is itself a dotted key is an untranslated leak.
  for (const [lang, dict] of Object.entries(masters)) {
    const keyish = Object.entries(dict).filter(([, v]) => typeof v === 'string' && KEY_SHAPE.test(v.trim()));
    if (keyish.length) {
      console.error(`Language ${lang} has ${keyish.length} value(s) shaped like an i18n key (likely an untranslated key pasted as a value):`);
      console.error(keyish.slice(0, 20).map(([k, v]) => `${k} = "${v}"`).join('\n'));
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
// substring check errs toward keeping keys, so this never deletes a live key.
// ---------------------------------------------------------------------------
const USAGE_SCAN_DIRS = ['apps', 'packaging', 'scripts', 'packages', 'config'];
const USAGE_EXTS = /\.(ts|tsx|js|jsx|cjs|mjs|json|html|sh|mako|yml|yaml)$/;
// Prefixes for keys consumed dynamically outside t()/tc() (e.g. the electron shell).
const DYNAMIC_KEY_ALLOWLIST = ['app.'];
// A dotted-key prefix ending at a dot boundary (e.g. "accounts.type.").
const KEY_PREFIX = /([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.)$/;

function collectSourceText(dir, skipAbs, acc) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build' || entry.name === 'coverage') continue;
    const full = path.join(dir, entry.name);
    if (skipAbs.has(full)) continue;
    if (entry.isDirectory()) collectSourceText(full, skipAbs, acc);
    else if (USAGE_EXTS.test(entry.name)) {
      try { acc.push(fs.readFileSync(full, 'utf8')); } catch { /* ignore unreadable */ }
    }
  }
  return acc;
}

// Skip the locale files themselves (they define every key, so they'd mark all "used").
const usageSkip = new Set([frontendLocales, packagingI18n]);
const usageChunks = [];
for (const d of USAGE_SCAN_DIRS) collectSourceText(path.join(repoRoot, d), usageSkip, usageChunks);
const haystack = usageChunks.join('\n');

// Dynamic prefixes: literal segment before the first `${` in a template literal,
// and the literal segment before a `+` string concatenation.
const dynamicPrefixes = new Set(DYNAMIC_KEY_ALLOWLIST);
const tplRe = /`([^`\\]*)\$\{/g;
let tpm;
while ((tpm = tplRe.exec(haystack))) {
  const lead = tpm[1].match(KEY_PREFIX);
  if (lead) dynamicPrefixes.add(lead[1]);
}
const concatRe = /['"]([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.)['"]\s*\+/g;
let ccm;
while ((ccm = concatRe.exec(haystack))) dynamicPrefixes.add(ccm[1]);

function keyIsUsed(key) {
  for (const p of dynamicPrefixes) if (key.startsWith(p)) return true;
  if (haystack.includes(key)) return true;
  // Plural variants: a live `tc('x')` only mentions the base key, not x.one/x.other.
  const base = key.replace(/\.(zero|one|two|few|many|other)$/, '');
  if (base !== key) {
    for (const p of dynamicPrefixes) if (base.startsWith(p)) return true;
    if (haystack.includes(base)) return true;
  }
  return false;
}

const unusedKeys = [...enKeys].filter((k) => !keyIsUsed(k));

if (process.argv.includes('--list-unused')) {
  process.stdout.write(unusedKeys.sort().join('\n') + (unusedKeys.length ? '\n' : ''));
  process.exit(0);
}

if (unusedKeys.length) {
  console.error(`Found ${unusedKeys.length} i18n key(s) defined in en.json but referenced nowhere in ${USAGE_SCAN_DIRS.join('/')}:`);
  console.error(unusedKeys.slice(0, 40).join('\n'));
  if (unusedKeys.length > 40) console.error(`... and ${unusedKeys.length - 40} more. Run \`node scripts/validate-locales.js --list-unused\` for the full list.`);
  failed = true;
}

if (failed) {
  fail('Locale validation failed.', 2);
}

console.log('Locale validation passed: parity, placeholders, types, source key-usage, unused-key, and generated-output drift checks are all clean.');
