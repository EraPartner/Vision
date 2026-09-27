#!/usr/bin/env node
/** Compare the documented HTTP method/path pairs with the authoritative spec. */
const { readFileSync } = require("node:fs");

const METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "TRACE",
]);
// These unversioned operational routes are documented separately from OpenAPI.
const HEALTH_OPERATIONS = new Set(["GET /health", "GET /health/detailed"]);

function normalizePath(path) {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

async function readSpecOperations(source) {
  // Use the declared generator dependency's public API for YAML parsing and
  // validation. Its paths AST marks absent HTTP methods as optional `never`.
  const { default: openapiTS } = await import("openapi-typescript");
  const ast = await openapiTS(source, { silent: true });
  const paths = ast.find((node) => node.name?.escapedText === "paths");
  if (!paths?.members) throw new Error("OpenAPI must declare a paths object.");
  const operations = new Set();
  for (const path of paths.members) {
    if (!path.type?.members) {
      throw new Error(
        `Cannot inspect OpenAPI path ${path.name?.text}: resolve its path-item reference first.`,
      );
    }
    for (const method of path.type.members) {
      const name = String(
        method.name?.escapedText ?? method.name?.text ?? "",
      ).toUpperCase();
      if (METHODS.has(name) && !method.questionToken) {
        operations.add(`${name} ${path.name.text}`);
      }
    }
  }
  return operations;
}

function readMatrixOperations(source) {
  const operations = new Set();
  const errors = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const cells = line.split("|");
    if (cells.length < 4) continue;
    const methods = cells[1].trim().split(/\s*,\s*/);
    const pathMatch = cells[2].trim().match(/^`(\/[^`]+)`$/);
    if (!pathMatch) {
      if (methods.some((method) => METHODS.has(method))) {
        errors.push(
          `Line ${index + 1}: invalid HTTP path ${JSON.stringify(cells[2].trim())}; use a backtick-quoted path starting with /.`,
        );
      }
      continue;
    }
    const path = normalizePath(pathMatch[1]);
    if (path.includes("*")) {
      errors.push(
        `Line ${index + 1}: wildcard path ${path} must list its concrete operations.`,
      );
      continue;
    }
    for (const method of methods) {
      if (!METHODS.has(method)) {
        errors.push(
          `Line ${index + 1}: invalid HTTP method ${JSON.stringify(method)} for ${path}.`,
        );
        continue;
      }
      const operation = `${method} ${path}`;
      if (operations.has(operation)) {
        errors.push(`Line ${index + 1}: duplicate operation ${operation}.`);
      }
      operations.add(operation);
    }
  }
  return { operations, errors };
}

async function checkMatrix(openapi, matrix) {
  const specOperations = await readSpecOperations(openapi);
  const { operations: matrixOperations, errors } = readMatrixOperations(matrix);
  for (const operation of HEALTH_OPERATIONS) {
    if (!specOperations.has(operation)) matrixOperations.delete(operation);
  }
  const declaredMatch = matrix.match(/^api_operation_count:\s*(\d+)\s*$/m);
  if (!declaredMatch) {
    errors.push("Matrix is missing the api_operation_count frontmatter key.");
  } else if (Number(declaredMatch[1]) !== specOperations.size) {
    errors.push(
      `OpenAPI declares ${specOperations.size} operations but api_operation_count is ${declaredMatch[1]}.`,
    );
  }
  const missing = [...specOperations]
    .filter((operation) => !matrixOperations.has(operation))
    .sort();
  const extra = [...matrixOperations]
    .filter((operation) => !specOperations.has(operation))
    .sort();
  if (missing.length)
    errors.push(
      `Missing from matrix:\n${missing.map((operation) => `  ${operation}`).join("\n")}`,
    );
  if (extra.length)
    errors.push(
      `Absent from OpenAPI:\n${extra.map((operation) => `  ${operation}`).join("\n")}`,
    );
  return { errors, count: specOperations.size };
}

async function main() {
  try {
    const { errors, count } = await checkMatrix(
      readFileSync("openapi.yaml", "utf8"),
      readFileSync("docs/reference/api-endpoint-matrix.md", "utf8"),
    );
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`[check-endpoint-matrix] in sync: ${count} method/path pairs.`);
  } catch (error) {
    console.error(`[check-endpoint-matrix] ${error.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
module.exports = { checkMatrix, readSpecOperations, readMatrixOperations };
