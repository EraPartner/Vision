import { describe, expect, it } from "vitest";
import {
  ANALYSIS_CONTRACT_VERSION,
  analysisDefinitionSchema,
  analysisExecutionResultSchema,
  checkAnalysisResultCompatibility,
} from "@vision/types/analysis";
import { calculateCostBasis } from "@vision/shared-utils/portfolio";
import type {
  AnalysisCompatibility,
  AnalysisCustomSqlSource,
  AnalysisDefinition,
  AnalysisVisualPlanSource,
} from "@vision/types/analysis";
import { ANALYSIS_REFERENCE_QUESTIONS_V1 } from "./fixtures/analysis/referenceQuestionsV1.ts";
import type { AnalysisReferenceQuestion } from "./fixtures/analysis/referenceQuestionsV1.ts";
import { must } from "./helpers/must.ts";

/** The last reference question: custom SQL paired with its visual origin. */
type CustomSqlDefinition = AnalysisDefinition & {
  source: AnalysisCustomSqlSource & { visualOrigin: AnalysisVisualPlanSource };
};
type CustomSqlReferenceQuestion = AnalysisReferenceQuestion & {
  definition: CustomSqlDefinition;
  visualDefinition: AnalysisDefinition & { source: AnalysisVisualPlanSource };
  visualResult: AnalysisReferenceQuestion["result"];
  nonConvertibleDefinition: CustomSqlDefinition;
};

/**
 * A structured clone typed as `unknown`: the tests corrupt it on purpose to
 * prove runtime validation, so it cannot keep the contract types. The path
 * helpers below read and write it, failing loudly on a missing fixture node.
 */
function clone(value: unknown): unknown {
  return structuredClone(value);
}

type TreePath = readonly (string | number)[];
type TreeNode = Record<string | number, unknown>;

function isTreeNode(value: unknown): value is TreeNode {
  return typeof value === "object" && value !== null;
}

function at(tree: unknown, path: TreePath): unknown {
  let node = tree;
  for (const key of path) {
    if (!isTreeNode(node) || !(key in node)) {
      throw new Error(`Fixture has no node at ${path.join(".")}`);
    }
    node = node[key];
  }
  return node;
}

function nodeAt(tree: unknown, path: TreePath): TreeNode {
  const node = at(tree, path);
  if (!isTreeNode(node)) {
    throw new Error(`Fixture node at ${path.join(".")} is not an object`);
  }
  return node;
}

function listAt(tree: unknown, path: TreePath): unknown[] {
  const node = at(tree, path);
  if (!Array.isArray(node)) {
    throw new Error(`Fixture node at ${path.join(".")} is not an array`);
  }
  return node;
}

/** Assigns `tree.<path> = value`; every node before the last key must exist. */
function put(tree: unknown, path: TreePath, value: unknown): void {
  const key = path.at(-1);
  if (key === undefined) throw new Error("put needs a non-empty path");
  nodeAt(tree, path.slice(0, -1))[key] = value;
}

/** `delete tree.<path>`; every node before the last key must exist. */
function remove(tree: unknown, path: TreePath): void {
  const key = path.at(-1);
  if (key === undefined) throw new Error("remove needs a non-empty path");
  delete nodeAt(tree, path.slice(0, -1))[key];
}

function messages(parsed: { error?: { issues: { message: string }[] } }) {
  return must(parsed.error, "parsed.error").issues.map(({ message }) => message);
}

function reasonCodes(definition: unknown, result: unknown) {
  const compatibility = checkAnalysisResultCompatibility(definition, result);
  expect(compatibility.compatible).toBe(false);
  return (
    compatibility as Extract<AnalysisCompatibility, { compatible: false }>
  ).reasons.map(({ code }) => code);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe("shared analysis contract", () => {
  it("accepts ten semantically distinct reference questions", () => {
    expect(ANALYSIS_CONTRACT_VERSION).toBe(1);
    expect(ANALYSIS_REFERENCE_QUESTIONS_V1).toHaveLength(10);
    const datasetIds = new Set(
      ANALYSIS_REFERENCE_QUESTIONS_V1.flatMap(({ definition }) =>
        definition.datasets.map(({ id }) => id),
      ),
    );
    expect(datasetIds.size).toBeGreaterThan(10);
    for (const fixture of ANALYSIS_REFERENCE_QUESTIONS_V1) {
      const definition = analysisDefinitionSchema.safeParse(fixture.definition);
      const result = analysisExecutionResultSchema.safeParse(fixture.result);
      expect(
        definition.success,
        `${fixture.id}: ${definition.success ? "" : messages(definition)}`,
      ).toBe(true);
      expect(
        result.success,
        `${fixture.id}: ${result.success ? "" : messages(result)}`,
      ).toBe(true);
      expect(
        checkAnalysisResultCompatibility(fixture.definition, fixture.result),
        fixture.id,
      ).toEqual({ compatible: true });
    }

    const recurring = must(ANALYSIS_REFERENCE_QUESTIONS_V1[1], "ANALYSIS_REFERENCE_QUESTIONS_V1[1]");
    expect(
      recurring.result.data.rows.map(({ values }) => values.classification),
    ).toEqual(["recurring", "discretionary"]);
    const contracts = must(ANALYSIS_REFERENCE_QUESTIONS_V1[2], "ANALYSIS_REFERENCE_QUESTIONS_V1[2]");
    expect(
      contracts.result.data.rows.map(({ values }) => values.contract),
    ).toEqual(["A", "B"]);
    const overlap = must(ANALYSIS_REFERENCE_QUESTIONS_V1[4], "ANALYSIS_REFERENCE_QUESTIONS_V1[4]");
    expect(overlap.result.coverage.dimensions[0]).toMatchObject({
      status: "partial",
      missingRatio: "0.12",
    });
    const filing = must(ANALYSIS_REFERENCE_QUESTIONS_V1[6], "ANALYSIS_REFERENCE_QUESTIONS_V1[6]");
    expect(filing.result.data.rows.map(({ values }) => values.version)).toEqual(
      ["2026-q2", "2026-q2-amended"],
    );
    const contradiction = must(ANALYSIS_REFERENCE_QUESTIONS_V1[8], "ANALYSIS_REFERENCE_QUESTIONS_V1[8]");
    expect(
      contradiction.result.data.rows.map(({ values }) => values.source_status),
    ).toEqual(["supports", "contradicts"]);
    expect(must(contradiction.result.coverage.dimensions[0], "contradiction.result.coverage.dimensions[0]").status).toBe(
      "unavailable",
    );

    const refund =
      must(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").result.data.rows[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]!.result.data.rows[0]").values;
    expect(Number(refund.gross_spend) + Number(refund.refunds)).toBe(
      Number(refund.net_flow),
    );
    expect(refund.transfer_excluded).toBe(true);
    expect(contracts.result.calculationResults[0]).toMatchObject({
      id: "scenario_total",
      value: "480",
    });

    const portfolio = must(ANALYSIS_REFERENCE_QUESTIONS_V1[3], "ANALYSIS_REFERENCE_QUESTIONS_V1[3]");
    const canonical = calculateCostBasis(must(portfolio.canonicalPortfolioInput, "portfolio.canonicalPortfolioInput"));
    expect(String(canonical.realizedGain)).toBe(
      must(portfolio.canonicalPortfolioExpected, "portfolio.canonicalPortfolioExpected").realizedGain,
    );
    expect(String(canonical.realizedGainConv)).toBe(
      must(portfolio.canonicalPortfolioExpected, "portfolio.canonicalPortfolioExpected").realizedGainReporting,
    );
    expect(String(canonical.totalCostConv)).toBe(
      must(portfolio.canonicalPortfolioExpected, "portfolio.canonicalPortfolioExpected").remainingCostReporting,
    );
    const portfolioRecordIds = portfolio.result.data.rows.flatMap(
      ({ lineage }) =>
        lineage.flatMap((entry) =>
          entry.kind === "records" ? entry.records.map(({ id }) => id) : [],
        ),
    );
    expect(portfolioRecordIds).toContain("partial-sale-usd");
    expect(must(portfolio.result.data.rows[0], "portfolio.result.data.rows[0]").values.source_currency).toBe("USD");
  });

  it("preserves custom SQL and proves the paired visual result", () => {
    const fixture = ANALYSIS_REFERENCE_QUESTIONS_V1.at(
      -1,
    ) as CustomSqlReferenceQuestion;
    const originalSql = fixture.definition.source.text;
    const parsed = analysisDefinitionSchema.parse(
      fixture.definition,
    ) as CustomSqlDefinition;
    expect(parsed.source.kind).toBe("custom-sql");
    expect(
      parsed.source.parameterBindings.map(({ parameterId }) => parameterId),
    ).toEqual(["multiplier", "minimum_rank"]);
    expect(parsed.source.visualConversion.status).toBe("convertible");
    expect(parsed.source.text).toBe(originalSql);
    expect(
      checkAnalysisResultCompatibility(
        fixture.visualDefinition,
        fixture.visualResult,
      ),
    ).toEqual({ compatible: true });
    expect(fixture.visualResult.execution.snapshot).toEqual(
      fixture.result.execution.snapshot,
    );
    expect(fixture.visualResult.data.rows).toEqual(fixture.result.data.rows);
    expect(fixture.visualDefinition.source.filters).toEqual(
      fixture.definition.source.visualOrigin.filters,
    );
    expect(fixture.result.calculationResults[0]).toMatchObject({
      id: "adjusted_amount",
      status: "ok",
    });

    const advanced = analysisDefinitionSchema.parse(
      fixture.nonConvertibleDefinition,
    ) as CustomSqlDefinition;
    expect(advanced.source.visualConversion.status).toBe("unsupported");
    expect(advanced.source.text).toContain("amount::numeric");
    expect(advanced.source.text).toContain("$$:body$$");
    expect(advanced.source.text).toContain("':literal'");

    const undeclared = clone(fixture.definition);
    put(
      undeclared,
      ["source", "parameterBindings", 0, "parameterId"],
      "undeclared",
    );
    expect(messages(analysisDefinitionSchema.safeParse(undeclared))).toContain(
      "Unknown parameter: undeclared",
    );

    const corruptOrigin = clone(fixture.definition);
    put(corruptOrigin, ["source", "visualOrigin", "datasetId"], "undeclared");
    put(
      corruptOrigin,
      ["source", "visualOrigin", "select", 0, "id"],
      "not-an-output",
    );
    put(
      corruptOrigin,
      ["source", "visualOrigin", "filters", 0, "right", "id"],
      "missing-param",
    );
    expect(messages(analysisDefinitionSchema.safeParse(corruptOrigin))).toEqual(
      expect.arrayContaining([
        "Unknown dataset: undeclared",
        "Selected output is not declared: not-an-output",
        "Unknown parameter: missing-param",
      ]),
    );
  });

  it("rejects dangling references, raw visual predicates, and presentation drift", () => {
    const definition = clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").definition);
    listAt(definition, ["datasets"]).push({
      ...nodeAt(definition, ["datasets", 0]),
    });
    listAt(definition, ["presentations", 0, "bindings", "columns"]).push(
      "missing_output",
    );
    const parsed = analysisDefinitionSchema.safeParse(definition);
    expect(messages(parsed)).toEqual(
      expect.arrayContaining([
        "Duplicate id: transactions",
        "Unknown presentation binding: missing_output",
      ]),
    );

    const raw = clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[1], "ANALYSIS_REFERENCE_QUESTIONS_V1[1]").definition);
    put(raw, ["source", "filters"], ["amount > :minimum"]);
    expect(analysisDefinitionSchema.safeParse(raw).success).toBe(false);

    const missingSelection = clone(
      must(ANALYSIS_REFERENCE_QUESTIONS_V1[1], "ANALYSIS_REFERENCE_QUESTIONS_V1[1]").definition,
    );
    put(
      missingSelection,
      ["source", "select"],
      listAt(missingSelection, ["source", "select"]).filter(
        (item) => at(item, ["id"]) !== "amount",
      ),
    );
    expect(
      messages(analysisDefinitionSchema.safeParse(missingSelection)),
    ).toContain("Raw result column is not selected: amount");

    const presentation = clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").definition);
    const requiredColumns = ["presentations", 0, "requires", "columns"];
    put(
      presentation,
      requiredColumns,
      listAt(presentation, requiredColumns).map((value, index) =>
        index === 1 ? { ...nodeAt(value, []), nullable: true } : value,
      ),
    );
    expect(
      messages(analysisDefinitionSchema.safeParse(presentation)),
    ).toContain("Presentation column contract differs: gross_spend");

    const chartFixture = must(ANALYSIS_REFERENCE_QUESTIONS_V1[3], "ANALYSIS_REFERENCE_QUESTIONS_V1[3]");
    expect(must(chartFixture.definition.presentations[0], "chartFixture.definition.presentations[0]").kind).toBe("bar");
    const chartResult = clone(chartFixture.result);
    put(chartResult, ["data", "columns", 1], {
      ...nodeAt(chartResult, ["data", "columns", 1]),
      unit: { ...nodeAt(chartResult, ["data", "columns", 1, "unit"]), scale: 3 },
    });
    expect(reasonCodes(chartFixture.definition, chartResult)).toEqual(
      expect.arrayContaining([
        "column-contract-mismatch",
        "incompatible-presentation-column",
      ]),
    );
  });

  it("validates defaults, effective inputs, and reporting scope", () => {
    const fixture = must(ANALYSIS_REFERENCE_QUESTIONS_V1[2], "ANALYSIS_REFERENCE_QUESTIONS_V1[2]");
    const definition = clone(fixture.definition);
    put(definition, ["assumptions", 0, "defaultValue"], 40);
    expect(messages(analysisDefinitionSchema.safeParse(definition))).toContain(
      "Default value does not match decimal",
    );

    const badCurrencyBinding = clone(fixture.definition);
    const currencyIndex = listAt(badCurrencyBinding, ["parameters"]).findIndex(
      (parameter) => at(parameter, ["id"]) === "currency",
    );
    put(badCurrencyBinding, ["parameters", currencyIndex, "required"], false);
    expect(
      messages(analysisDefinitionSchema.safeParse(badCurrencyBinding)),
    ).toEqual(
      expect.arrayContaining([
        "Reporting parameter must be required currency",
        "Money unit currency parameter must name a currency parameter",
      ]),
    );

    const cycle = clone(fixture.definition);
    listAt(cycle, ["calculations", 0, "dependencies"]).push("scenario_total");
    expect(messages(analysisDefinitionSchema.safeParse(cycle))).toContain(
      "Calculation dependency cycle: scenario_total",
    );

    const result = clone(fixture.result);
    put(result, ["execution", "effectiveAssumptions", "monthly_price"], 40);
    remove(result, ["execution", "effectiveParameters", "date_to"]);
    put(result, ["execution", "effectiveParameters", "undeclared"], "x");
    put(result, ["reporting", "currency"], "USD");
    expect(reasonCodes(fixture.definition, result)).toEqual(
      expect.arrayContaining([
        "unknown-effective-input",
        "missing-effective-input",
        "effective-input-type-mismatch",
        "reporting-scope-mismatch",
      ]),
    );
  });

  it("enforces terminal status and row-window invariants", () => {
    const fixture = must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]");
    const running = clone(fixture.result);
    put(running, ["status"], "running");
    expect(analysisExecutionResultSchema.safeParse(running).success).toBe(
      false,
    );

    const complete = clone(fixture.result);
    put(complete, ["data", "window", "totalRows"], 2);
    expect(
      messages(analysisExecutionResultSchema.safeParse(complete)),
    ).toContain("Complete row count must equal returned rows");

    const page = clone(fixture.result);
    put(page, ["data", "window"], {
      kind: "page",
      offset: 0,
      limit: 1,
      totalRows: 1,
      hasMore: true,
    });
    expect(messages(analysisExecutionResultSchema.safeParse(page))).toContain(
      "Page total and hasMore are inconsistent",
    );

    const unknownTotal = clone(fixture.result);
    put(unknownTotal, ["data", "window"], {
      kind: "page",
      offset: 0,
      limit: 1,
      hasMore: false,
    });
    expect(
      messages(analysisExecutionResultSchema.safeParse(unknownTotal)),
    ).toContain("A full page with unknown total cannot prove it is final");

    const truncated = clone(fixture.result);
    put(truncated, ["data", "window"], {
      kind: "truncated",
      returnedRows: 2,
      rowLimit: 1,
      reason: "limit",
    });
    expect(
      messages(analysisExecutionResultSchema.safeParse(truncated)),
    ).toContain("Truncated row counts are inconsistent");
  });

  it("enforces dataset, coverage, lineage, grain, and row identity", () => {
    const result = clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").result);
    listAt(result, ["coverage", "datasets"]).pop();
    put(result, ["data", "rows", 0, "lineage", 0, "datasetId"], "undeclared");
    put(result, ["data", "rowGrain", "keys"], ["missing"]);
    listAt(result, ["data", "rows"]).push(clone(at(result, ["data", "rows", 0])));
    listAt(result, ["coverage", "dimensions"]).push({
      id: "invalid-ratio",
      status: "partial",
      missingRatio: "1.1",
      sources: [],
    });
    const parsed = analysisExecutionResultSchema.safeParse(result);
    expect(messages(parsed)).toEqual(
      expect.arrayContaining([
        "Coverage datasets must equal source-version datasets",
        "Unknown lineage dataset: undeclared",
        "Unknown row-grain key: missing",
        `Duplicate id: ${String(at(result, ["data", "rows", 0, "id"]))}`,
        "Duplicate row-grain tuple",
        "Missing ratio must be between zero and one",
      ]),
    );

    const falseComplete = clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[3], "ANALYSIS_REFERENCE_QUESTIONS_V1[3]").result);
    put(falseComplete, ["coverage", "datasets", 0, "missingRatio"], "1");
    expect(
      messages(analysisExecutionResultSchema.safeParse(falseComplete)),
    ).toContain("Complete coverage cannot declare a positive missing ratio");
  });

  it("fails closed on definition, dataset, calculation, column, and completeness drift", () => {
    const fixture = must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]");
    const result = clone(fixture.result);
    put(result, ["definitionRef", "definitionVersion"], 2);
    put(result, ["sourceVersions", 0, "schemaVersion"], 2);
    put(result, ["calculationResults", 0, "version"], "transfer-refund-v2");
    put(result, ["data", "columns", 1, "unit", "scale"], 3);
    put(result, ["status"], "partial");
    put(result, ["coverage", "status"], "partial");
    expect(reasonCodes(fixture.definition, result)).toEqual(
      expect.arrayContaining([
        "definition-version-mismatch",
        "dataset-version-mismatch",
        "calculation-contract-mismatch",
        "column-contract-mismatch",
        "incomplete-presentation-input",
      ]),
    );
  });

  it("rejects calculation errors and malformed row values", () => {
    const fixture = must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]");
    const result = clone(fixture.result);
    put(result, ["data", "rows", 0, "values", "net_flow"], 420);
    put(result, ["data", "rows", 0, "values", "unexpected"], "value");
    expect(messages(analysisExecutionResultSchema.safeParse(result))).toEqual(
      expect.arrayContaining([
        "Value does not match decimal",
        "Unknown column value: unexpected",
      ]),
    );

    const errored = clone(fixture.result);
    put(errored, ["calculationResults", 0], {
      id: "net_flow",
      status: "error",
      kind: "metric",
      version: "transfer-refund-v1",
      type: "decimal",
      unit: clone(must(fixture.definition.calculations[0], "fixture.definition.calculations[0]").unit),
      error: { code: "metric-failed", message: "Fixture failure" },
    });
    expect(reasonCodes(fixture.definition, errored)).toContain(
      "calculation-error",
    );
  });

  it("does not mutate saved definitions or frozen results", () => {
    const definition = deepFreeze(
      clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").definition),
    );
    const result = deepFreeze(clone(must(ANALYSIS_REFERENCE_QUESTIONS_V1[0], "ANALYSIS_REFERENCE_QUESTIONS_V1[0]").result));
    const beforeDefinition = JSON.stringify(definition);
    const beforeResult = JSON.stringify(result);
    expect(checkAnalysisResultCompatibility(definition, result)).toEqual({
      compatible: true,
    });
    expect(JSON.stringify(definition)).toBe(beforeDefinition);
    expect(JSON.stringify(result)).toBe(beforeResult);
  });
});
