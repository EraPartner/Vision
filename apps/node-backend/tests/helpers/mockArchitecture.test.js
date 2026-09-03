import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const testsRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function testFiles(dir = testsRoot) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(absolute);
    return entry.name.endsWith(".test.js") ? [absolute] : [];
  });
}

function relative(file) {
  return path.relative(testsRoot, file);
}

function mockCalls(source) {
  const calls = [];
  const startPattern = /vi\.(?:mock|doMock)\s*\(/g;
  let match;

  while ((match = startPattern.exec(source))) {
    let depth = 0;
    let quote = null;
    let escaped = false;
    let lineComment = false;
    let blockComment = false;
    let end = match.index;

    for (
      let index = source.indexOf("(", match.index);
      index < source.length;
      index += 1
    ) {
      const char = source[index];
      const next = source[index + 1];

      if (lineComment) {
        if (char === "\n") lineComment = false;
        continue;
      }
      if (blockComment) {
        if (char === "*" && next === "/") {
          blockComment = false;
          index += 1;
        }
        continue;
      }
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === "/" && next === "/") {
        lineComment = true;
        index += 1;
        continue;
      }
      if (char === "/" && next === "*") {
        blockComment = true;
        index += 1;
        continue;
      }
      if (char === '"' || char === "'" || char === "`") {
        quote = char;
        continue;
      }
      if (char === "(") depth += 1;
      if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }

    if (end > match.index) calls.push(source.slice(match.index, end));
    startPattern.lastIndex = Math.max(end, startPattern.lastIndex);
  }

  return calls;
}

function manualModuleMocks(source, moduleName, helpers) {
  return mockCalls(source).filter(
    (call) =>
      call.includes(moduleName) &&
      !helpers.some((helper) => call.includes(`${helper}(`)),
  );
}

describe("shared database and currency mock architecture", () => {
  it("routes connection module mocks through repoMocks except partial-real DB instrumentation", () => {
    const allowedPartialReal = new Set([
      "dataImport.db.test.js",
      "portfolioImportRollback.db.test.js",
    ]);
    const offenders = [];

    for (const file of testFiles()) {
      if (relative(file) === "helpers/mockArchitecture.test.js") continue;
      const source = readFileSync(file, "utf8");
      if (
        !allowedPartialReal.has(relative(file)) &&
        manualModuleMocks(source, "database/connection.js", [
          "mockConnection",
          "mockTxConnection",
          "mockPooledTxConnection",
        ]).length > 0
      ) {
        offenders.push(relative(file));
      }
    }

    expect(offenders).toEqual([]);
  });

  it("routes convertRowsToEur module mocks through the canonical currency fake", () => {
    const offenders = [];
    for (const file of testFiles()) {
      if (relative(file) === "helpers/mockArchitecture.test.js") continue;
      const source = readFileSync(file, "utf8");
      const manualMocks = manualModuleMocks(
        source,
        "currencyConversionService.js",
        ["mockCurrencyConversion"],
      ).filter((call) => call.includes("convertRowsToEur"));
      if (manualMocks.length > 0) {
        offenders.push(relative(file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("rejects multiline manual mocks even when a helper is mentioned later", () => {
    const source = `
      vi.mock(
        "../src/database/connection.js",
        () => ({ query: vi.fn() }),
      );
      const unrelated = mockConnection();
      vi.doMock("../src/services/currency/currencyConversionService.js", () => ({
        convertRowsToEur: vi.fn(),
      }));
      const alsoUnrelated = mockCurrencyConversion();
    `;

    expect(
      manualModuleMocks(source, "database/connection.js", ["mockConnection"]),
    ).toHaveLength(1);
    expect(
      manualModuleMocks(source, "currencyConversionService.js", [
        "mockCurrencyConversion",
      ]),
    ).toHaveLength(1);
  });

  it("accepts only helpers invoked inside the matching mock factory", () => {
    const source = `
      vi.mock("../src/database/connection.js", () => mockTxConnection());
      vi.mock("../src/services/currency/currencyConversionService.js", () =>
        mockCurrencyConversion(),
      );
    `;

    expect(
      manualModuleMocks(source, "database/connection.js", [
        "mockConnection",
        "mockTxConnection",
      ]),
    ).toEqual([]);
    expect(
      manualModuleMocks(source, "currencyConversionService.js", [
        "mockCurrencyConversion",
      ]),
    ).toEqual([]);
  });
});
