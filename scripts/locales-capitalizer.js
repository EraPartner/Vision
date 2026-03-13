#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const files = [
  'apps/frontend/src/locales/en.ts',
  'apps/frontend/src/locales/nl.ts',
];

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function writeFile(p, content) {
  fs.writeFileSync(p, content, 'utf8');
}

function isAlpha(ch) {
  return /[A-Za-zÀ-ÖØ-öø-ÿ]/.test(ch);
}

function findFirstAlphaIndex(str) {
  for (let i = 0; i < str.length; i++) {
    if (isAlpha(str[i])) return i;
  }
  return -1;
}

function looksLikeSentence(val) {
  const words = val.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 6) return false;
  if (/[\.\?|!|…]/.test(val)) return true;
  if (val.length > 80) return true;
  return false;
}

function safeToCapitalize(key, val) {
  if (!val || typeof val !== 'string') return false;
  const trimmed = val.trim();
  if (!trimmed) return false;
  // common exclusions
  if (/^\{/.test(trimmed)) return false; // starts with interpolation
  if (/^https?:\/\//i.test(trimmed)) return false;
  if (/^[0-9]/.test(trimmed)) return false;
  if (/^[✓✗⊘+\-•»]/.test(trimmed)) return false;
  if (/^e\.g\.|^eg\.|^bijv\.|^bv\.|^bijvoorbeeld/i.test(trimmed)) return false;
  if (/\bhttps?:\/\//.test(trimmed)) return false;
  if (trimmed.includes('\n')) return false;
  if (trimmed.startsWith('…')) return false;

  // if it looks like a full sentence, skip
  if (looksLikeSentence(trimmed)) return false;

  // If the first alphabetic character is already uppercase, nothing to do
  const idx = findFirstAlphaIndex(trimmed);
  if (idx === -1) return false;
  const ch = trimmed[idx];
  if (ch === ch.toUpperCase()) return false;

  // force-capitalize for specific key patterns (likely labels/titles/placeholders)
  const forcePatterns = [
    /\.title$/,
    /\.label$/,
    /\.name$/,
    /\.namePlaceholder$/,
    /\.placeholder$/,
    /\.button$/,
    /\.btn$/,
    /\.tab(\.|$)/,
    /(^|\.)subtitle$/,
    /(^|\.)heading$/,
    /(^|\.)col(\.|$)/,
    /(^|\.)page$/,
    /(^|\.)save$/,
    /(^|\.)cancel$/,
    /(^|\.)add$/,
    /(^|\.)delete$/,
    /(^|\.)edit$/,
    /^nav\./,
    /^common\./,
    /^settings\./,
    /\.freq\./,
    /\.type$/,
    /\.title\./,
  ];

  for (const re of forcePatterns) {
    if (re.test(key)) return true;
  }

  // small tokens / single words are safe
  if (trimmed.split(/\s+/).length <= 2) return true;

  return false;
}

function capitalizeFirstAlpha(val) {
  const idx = findFirstAlphaIndex(val);
  if (idx === -1) return val;
  return val.slice(0, idx) + val[idx].toUpperCase() + val.slice(idx + 1);
}

function parseAndTransform(content, filePath) {
  const out = [];
  let i = 0;
  const len = content.length;
  // We'll scan line-by-line but parse key/value pairs robustly
  const lines = content.split('\n');
  const changes = [];

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const m = line.match(/^(\s*)'([^']+)':\s*/);
    if (!m) {
      out.push(line);
      continue;
    }
    const indent = m[1] || '';
    const key = m[2];
    // find start of value (first single quote after colon)
    const after = line.indexOf("'", m[0].length - 1);
    if (after === -1) { out.push(line); continue; }
    let val = '';
    let rest = '';
    let accum = '';
    // scan from that position across lines to find closing unescaped '
    let found = false;
    let col = after + 1;
    let li2 = li;
    let s = line;
    while (!found && li2 < lines.length) {
      for (; col < s.length; col++) {
        const ch = s[col];
        if (ch === "'") {
          // check if escaped
          let back = col - 1;
          let esc = false;
          while (back >= 0 && s[back] === '\\') { esc = !esc; back--; }
          if (!esc) {
            // closing quote found
            val += s.slice(after + 1, col);
            rest = s.slice(col + 1);
            found = true;
            break;
          }
        }
      }
      if (!found) {
        // append whole remainder plus newline
        val += s.slice(after + 1) + '\n';
        li2++;
        s = lines[li2] || '';
        col = 0;
      }
    }
    if (!found) { out.push(line); continue; }

    const originalValue = val;
    // rest may contain trailing comma and comments; reconstruct
    const trailing = rest;

    const should = safeToCapitalize(key, originalValue);
    let newValue = originalValue;
    if (should) {
      newValue = capitalizeFirstAlpha(originalValue);
    }

    if (newValue !== originalValue) {
      changes.push({ key, oldValue: originalValue, newValue, file: filePath });
    }

    // rebuild line(s)
    const rebuilt = indent + `'${key}': '${newValue}'` + trailing;
    out.push(rebuilt);
    // if we consumed multiple lines, skip them
    li = li2;
  }

  return { content: out.join('\n'), changes };
}

function run() {
  const allChanges = [];
  for (const f of files) {
    const abs = path.resolve(f);
    if (!fs.existsSync(abs)) {
      console.error('Missing file:', f);
      continue;
    }
    const src = readFile(abs);
    const res = parseAndTransform(src, f);
    const outPath = abs + '.capitalized.tmp';
    writeFile(outPath, res.content);
    allChanges.push(...res.changes);
  }

  // write report
  const report = { total: allChanges.length, changes: allChanges };
  const reportPath = path.resolve('scripts/locales-capitalizer-report.json');
  writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log('Wrote modified temp files and report:', reportPath);
  console.log('Total proposed changes:', allChanges.length);
  // print a brief summary to stdout
  for (let i = 0; i < Math.min(50, allChanges.length); i++) {
    const c = allChanges[i];
    console.log(`${c.file} | ${c.key}`);
    console.log(` - ${c.oldValue}`);
    console.log(` + ${c.newValue}`);
  }
  if (allChanges.length > 50) console.log(`...and ${allChanges.length - 50} more`);
}

run();
