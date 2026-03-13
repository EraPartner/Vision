#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function dedupeFile(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Find the object literal start (first '{' after the `const <id>:`)
  const objStart = src.indexOf('= {');
  if (objStart === -1) {
    console.error('Could not find object start in', filePath);
    return;
  }
  const before = src.slice(0, objStart + 3);
  // Find the export default line to locate end of object
  const exportIdx = src.lastIndexOf('\n};');
  if (exportIdx === -1) {
    console.error('Could not find object end in', filePath);
    return;
  }
  const after = src.slice(exportIdx + 3);
  const body = src.slice(objStart + 3, exportIdx + 1);

  const lines = body.split('\n');
  const seen = new Set();
  const out = [];

  const keyLineRe = /^\s*'([^']+)'\s*:\s*([`'])([\s\S]*?)\2,?\s*$/;

  for (const line of lines) {
    const m = line.match(keyLineRe);
    if (m) {
      const key = m[1];
      if (seen.has(key)) {
        // skip duplicate
        continue;
      }
      seen.add(key);
      out.push(line);
    } else {
      // preserve blank lines or comments within the object
      out.push(line);
    }
  }

  const newSrc = before + '\n' + out.join('\n') + '\n' + after;
  fs.writeFileSync(filePath, newSrc, 'utf8');
  console.log('Dedupe complete:', filePath, '(kept', seen.size, 'keys)');
}

const targets = [
  path.join('apps', 'frontend', 'src', 'locales', 'en.ts'),
  path.join('apps', 'frontend', 'src', 'locales', 'nl.ts'),
];

for (const t of targets) {
  if (fs.existsSync(t)) dedupeFile(t);
  else console.warn('Skipping missing file', t);
}
