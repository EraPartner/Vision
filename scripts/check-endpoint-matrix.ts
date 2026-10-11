#!/usr/bin/env bun
/** Compare the documented HTTP method/path pairs with the authoritative spec. */
import { readFileSync } from "node:fs";
import ts from "typescript";
import { isEntrypoint } from "./lib/isEntrypoint.ts";

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

export interface MatrixCheckResult {
  errors: string[];
  count: number;
}

function normalizePath(path: string): string {
  return path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
}

function propertyNameText(name: ts.PropertyName | undefined): string {
  if (
    name !== undefined &&
    (ts.isIdentifier(name) ||
      ts.isStringLiteral(name) ||
      ts.isNumericLiteral(name))
  ) {
    return name.text;
  }
  return "";
}

export async function readSpecOperations(source: string): Promise<Set<string>> {
  // Use the declared generator dependency's public API for YAML parsing and
  // validation. Its paths AST marks absent HTTP methods as optional `never`.
  const { default: openapiTS } = await import("openapi-typescript");
  const ast = await openapiTS(source, { silent: true });
  const paths = ast.find(
    (node): node is ts.InterfaceDeclaration =>
      ts.isInterfaceDeclaration(node) && node.name.text === "paths",
  );
  if (!paths) throw new Error("OpenAPI must declare a paths object.");
  const operations = new Set<string>();
  for (const path of paths.members) {
    const pathName = propertyNameText(path.name);
    if (
      !ts.isPropertySignature(path) ||
      path.type === undefined ||
      !ts.isTypeLiteralNode(path.type)
    ) {
      throw new Error(
        `Cannot inspect OpenAPI path ${pathName}: resolve its path-item reference first.`,
      );
    }
    for (const method of path.type.members) {
      const name = propertyNameText(method.name).toUpperCase();
      if (METHODS.has(name) && !method.questionToken) {
        operations.add(`${name} ${pathName}`);
      }
    }
  }
  return operations;
}

export function readMatrixOperations(source: string): {
  operations: Set<string>;
  errors: string[];
} {
  const operations = new Set<string>();
  const errors: string[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const cells = line.split("|");
    const [, methodCell, pathCell] = cells;
    if (cells.length < 4 || methodCell === undefined || pathCell === undefined)
      continue;
    const methods = methodCell.trim().split(/\s*,\s*/);
    const pathMatch = pathCell.trim().match(/^`(\/[^`]+)`$/);
    if (!pathMatch?.[1]) {
      if (methods.some((method) => METHODS.has(method))) {
        errors.push(
          `Line ${index + 1}: invalid HTTP path ${JSON.stringify(pathCell.trim())}; use a backtick-quoted path starting with /.`,
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

export async function checkMatrix(
  openapi: string,
  matrix: string,
): Promise<MatrixCheckResult> {
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

async function main(): Promise<void> {
  try {
    const { errors, count } = await checkMatrix(
      readFileSync("openapi.yaml", "utf8"),
      readFileSync("docs/reference/api-endpoint-matrix.md", "utf8"),
    );
    if (errors.length) throw new Error(errors.join("\n"));
    console.log(`[check-endpoint-matrix] in sync: ${count} method/path pairs.`);
  } catch (error) {
    console.error(
      `[check-endpoint-matrix] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}

if (isEntrypoint(import.meta)) void main();
