#!/usr/bin/env node
/**
 * Guards docs/reference/api-endpoint-matrix.md against drift from openapi.yaml.
 *
 * openapi.yaml is the authoritative API spec. This counts the HTTP operations
 * declared there and compares them to the `api_operation_count` value in the
 * matrix doc's frontmatter. A mismatch (exit 1) means an endpoint was added or
 * removed without updating the matrix — caught in CI (verify-generated) instead
 * of rotting into the "counts contradict themselves" state the doc was in.
 *
 * Run from the repo root: `node scripts/check-endpoint-matrix.js`
 */
const { readFileSync } = require('node:fs');

const OPENAPI = 'openapi.yaml';
const MATRIX = 'docs/reference/api-endpoint-matrix.md';

function fail(msg) {
  console.error(`[check-endpoint-matrix] ${msg}`);
  process.exit(1);
}

const openapi = readFileSync(OPENAPI, 'utf8');
// Path operations are the only method keys indented exactly 4 spaces under a
// `  /path:` entry. `responses:`/content method-like keys live deeper, so this
// does not over-count.
const operationCount = (openapi.match(/^ {4}(get|post|put|patch|delete):/gm) || []).length;

const matrix = readFileSync(MATRIX, 'utf8');
const declaredMatch = matrix.match(/^api_operation_count:\s*(\d+)\s*$/m);
if (!declaredMatch) {
  fail(`${MATRIX} is missing the \`api_operation_count\` frontmatter key.`);
}
const declared = Number(declaredMatch[1]);

if (declared !== operationCount) {
  fail(
    `Endpoint matrix drift: ${OPENAPI} declares ${operationCount} operations but ${MATRIX} ` +
      `says api_operation_count: ${declared}.\n` +
      `  → Update the matrix (resource tables + the header count) and bump ` +
      `api_operation_count to ${operationCount}.`,
  );
}

console.log(`[check-endpoint-matrix] in sync: ${operationCount} operations.`);
