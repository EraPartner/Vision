#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const srcDir = path.join('i18n', 'source');
const enPath = path.join(srcDir, 'en.json');
const nlPath = path.join(srcDir, 'nl.json');

if (!fs.existsSync(enPath)) { console.error('Missing', enPath); process.exit(1); }
if (!fs.existsSync(nlPath)) { console.error('Missing', nlPath); process.exit(1); }

const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
const nl = JSON.parse(fs.readFileSync(nlPath, 'utf8'));

let added = 0;
for (const [k, v] of Object.entries(en)) {
  if (!Object.prototype.hasOwnProperty.call(nl, k) || nl[k] === null || nl[k] === '') {
    nl[k] = v; // fallback to English
    added++;
  }
}

fs.writeFileSync(nlPath, JSON.stringify(nl, null, 2) + '\n', 'utf8');
console.log(`Synced nl.json with en.json — added ${added} keys (fallback to English).`);
process.exit(0);
