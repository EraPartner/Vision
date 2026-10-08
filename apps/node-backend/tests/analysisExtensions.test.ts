import { describe, it, expect } from "vitest";
import { evaluateAnalysisFormulas } from "../src/services/analysisFormulaEngine.ts";
import {
  prepareAnalysisData,
  compareAnalysisTime,
  runAnalysisScenarios,
  buildAnalysisSensitivity,
  seekAnalysisGoal,
} from "../src/services/analysisExtensions.ts";
import type { PrepareAnalysisDataInput } from "../src/services/analysisExtensions.ts";
const columns = [
  { id: "date", type: "date" },
  { id: "amount", type: "decimal", unit: { kind: "money", currency: "EUR" } },
  { id: "category", type: "string" },
];
const rows = [
  { date: "2024-01-15", amount: "10", category: "A" },
  { date: "2024-03-15", amount: "30", category: "A" },
];
const formulas = [
  {
    id: "outcome",
    scope: "summary",
    expression: "SUM(amount) * assumption.rate",
  },
];
describe("bounded analysis extensions", () => {
  it("rejects pivot output collisions and overlapping calendar roles", () => {
    expect(() =>
      prepareAnalysisData({
        columns: [...columns, { id: "pivot_0", type: "string" }],
        rows: rows.map((row) => ({ ...row, pivot_0: "retained group" })),
        steps: [
          {
            type: "pivot",
            groupColumns: ["pivot_0"],
            nameColumn: "category",
            valueColumn: "amount",
          },
        ],
      }),
    ).toThrow("conflicts with a retained group");
    expect(() =>
      compareAnalysisTime({
        rows,
        columns,
        dateColumn: "date",
        groupColumns: ["amount"],
        valueColumns: ["amount"],
      }),
    ).toThrow("must be distinct");
  });
  it("fills missing periods explicitly and does calendar comparisons without fabricating data", () => {
    const output = compareAnalysisTime({
      rows,
      columns,
      dateColumn: "date",
      valueColumns: ["amount"],
    });
    expect(output.rows.map((row) => row.amount)).toEqual(["10", null, "30"]);
    expect(output.rows[2].amount_previous).toBeNull();
    expect(output.rows[2].amount_cumulative).toBeNull();
    expect(output.coverage.missingPeriods).toBe(1);
    const zero = compareAnalysisTime({
      rows,
      columns,
      dateColumn: "date",
      valueColumns: ["amount"],
      missing: "zero",
      rollingWindow: 2,
    });
    expect(zero.rows[2].amount_cumulative).toBe("40");
    expect(zero.rows[2].amount_rolling_average).toBe("15");
  });
  it("uses ISO Monday weeks and leap-day prior-year clamping", () => {
    const weeks = compareAnalysisTime({
      rows: [{ date: "2024-01-07", amount: "1", category: "A" }],
      columns,
      dateColumn: "date",
      valueColumns: ["amount"],
      bucket: "week",
    });
    expect(weeks.rows[0].date).toBe("2024-01-01");
    const years = compareAnalysisTime({
      rows: [
        { date: "2023-02-28", amount: "10", category: "A" },
        { date: "2024-02-29", amount: "15", category: "A" },
      ],
      columns,
      dateColumn: "date",
      valueColumns: ["amount"],
      bucket: "day",
      missing: "zero",
    });
    expect(years.rows.at(-1)!.amount_yoy).toBe("10");
    expect(years.rows.at(-1)!.amount_yoy_percent).toBe("50");
  });
  it("rejects partial population operations and mixed units", () => {
    expect(() =>
      compareAnalysisTime({
        rows,
        columns,
        complete: false,
        dateColumn: "date",
        valueColumns: ["amount"],
      }),
    ).toThrow("complete");
    expect(() =>
      compareAnalysisTime({
        rows: rows.map((row, i) => ({ ...row, currency: i ? "USD" : "EUR" })),
        columns: [...columns, { id: "currency", type: "currency" }],
        dateColumn: "date",
        valueColumns: ["amount"],
      }),
    ).toThrow("currency separation");
  });
  it("validates conversions and reports cell errors plus repeatable lineage", () => {
    const output = prepareAnalysisData({
      rows: [{ x: "1.5" }, { x: "bad" }],
      columns: [{ id: "x", type: "string" }],
      steps: [
        {
          type: "convert",
          columnId: "x",
          targetType: "decimal",
          onError: "null",
        },
      ],
    });
    expect(output.rows).toEqual([{ x: "1.5" }, { x: null }]);
    expect(output.errors).toHaveLength(1);
    expect(output.lineage[0]).toMatchObject({
      inputRows: 2,
      outputRows: 2,
      type: "convert",
    });
  });
  it("normalizes numeric lookup keys, reports missing rows, and rejects multiplication", () => {
    const input = {
      columns: [
        { id: "id", type: "decimal" },
        { id: "name", type: "string" },
      ],
      rows: [{ id: "1.0", name: "matched" }],
    };
    const request: PrepareAnalysisDataInput = {
      rows: [{ id: 1 }, { id: 2 }],
      columns: [{ id: "id", type: "integer" }],
      steps: [{ type: "lookup", input, keys: ["id"], inputKeys: ["id"] }],
    };
    const output = prepareAnalysisData(request);
    expect(output.rows[0]["input.name"]).toBe("matched");
    expect(output.lineage[0].unmatchedRows).toBe(1);
    input.rows.push({ id: "1", name: "duplicate" });
    expect(() => prepareAnalysisData(request)).toThrow("multiply");
  });
  it("pivots then unpivots and appends with typed contracts", () => {
    const output = prepareAnalysisData({
      rows,
      columns,
      steps: [
        {
          type: "pivot",
          groupColumns: ["category"],
          nameColumn: "date",
          valueColumn: "amount",
        },
        {
          type: "unpivot",
          columnIds: ["pivot_0", "pivot_1"],
          nameColumn: "period",
          valueColumn: "value",
        },
      ],
    });
    expect(output.rows.map((row) => row.value)).toEqual(["10", "30"]);
    expect(
      output.columns.find((column) => column.id === "value")!.unit!.currency,
    ).toBe("EUR");
    expect(() =>
      prepareAnalysisData({
        rows,
        columns,
        steps: [{ type: "append", input: { rows, columns: columns.slice(1) } }],
      }),
    ).toThrow("matching");
  });
  it("evaluates named scenarios independently without mutating the source", () => {
    const snapshot = structuredClone(rows);
    const output = runAnalysisScenarios({
      rows,
      columns,
      formulas,
      assumptions: { rate: "1" },
      scenarios: [{ id: "base" }, { id: "double", assumptions: { rate: "2" } }],
    });
    expect(output.scenarios.map((item) => item.summaries.outcome)).toEqual([
      "40",
      "80",
    ]);
    expect(rows).toEqual(snapshot);
  });
  it("computes two-variable sensitivity and finds a bracketed target", () => {
    const grid = buildAnalysisSensitivity({
      rows,
      columns,
      formulas: [
        {
          id: "outcome",
          scope: "summary",
          expression: "SUM(amount) * assumption.rate + assumption.offset",
        },
      ],
      outcomeId: "outcome",
      variables: [
        { id: "rate", values: ["1", "2"] },
        { id: "offset", values: ["0", "5"] },
      ],
    });
    expect(grid.rows.map((row) => row.outcome)).toEqual([
      "40",
      "45",
      "80",
      "85",
    ]);
    const goal = seekAnalysisGoal({
      rows,
      columns,
      formulas,
      outcomeId: "outcome",
      variableId: "rate",
      target: "60",
      lower: "0",
      upper: "3",
    });
    expect(goal).toMatchObject({
      converged: true,
      value: "1.5",
      outcome: "60",
    });
    expect(
      seekAnalysisGoal({
        rows,
        columns,
        formulas,
        outcomeId: "outcome",
        variableId: "rate",
        target: "1000",
        lower: "0",
        upper: "3",
      }),
    ).toMatchObject({ converged: false, reason: "target-not-bracketed" });
  });
});

describe("extension missing coverage and stock semantics", () => {
  it("withholds a calendar aggregate with a present missing value even when absent periods use zero", () => {
    const output = compareAnalysisTime({
      rows: [
        { date: "2024-01-01", amount: "10", category: "A" },
        { date: "2024-01-02", amount: null, category: "A" },
      ],
      columns,
      dateColumn: "date",
      valueColumns: ["amount"],
      missing: "zero",
    });
    expect(output.rows[0].amount).toBeNull();
    expect(output.coverage.complete).toBe(false);
    expect(output.errors[0].code).toBe("MISSING_CONTRIBUTOR");
  });
  it("withholds preparation pivots with missing contributors and rejects cross-unit append", () => {
    const output = prepareAnalysisData({
      rows: [
        { date: "Jan", amount: "10", category: "A" },
        { date: "Jan", amount: null, category: "A" },
      ],
      columns: columns.map((column) =>
        column.id === "date" ? { ...column, type: "string" } : column,
      ),
      steps: [
        {
          type: "pivot",
          groupColumns: ["category"],
          nameColumn: "date",
          valueColumn: "amount",
        },
      ],
    });
    expect(output.rows[0].pivot_0).toBeNull();
    expect(output.coverage.complete).toBe(false);
    expect(() =>
      prepareAnalysisData({
        rows,
        columns,
        steps: [
          {
            type: "append",
            input: {
              rows,
              columns: columns.map((column) =>
                column.id === "amount"
                  ? { ...column, unit: { kind: "money", currency: "USD" } }
                  : column,
              ),
            },
          },
        ],
      }),
    ).toThrow("matching");
  });
  it("takes last dated balance instead of summing stock levels", () => {
    const request = {
      rows: [
        { date: "2024-01-31", amount: "110", category: "A" },
        { date: "2024-01-01", amount: "100", category: "A" },
      ],
      columns: columns.map((column) =>
        column.id === "amount" ? { ...column, temporalKind: "stock" } : column,
      ),
      dateColumn: "date",
      valueColumns: ["amount"],
    };
    expect(() => compareAnalysisTime(request)).toThrow("last aggregation");
    expect(
      compareAnalysisTime({ ...request, aggregation: "last" }).rows[0].amount,
    ).toBe("110");
  });
});

describe("extension output unit resolution", () => {
  it("resolves omitted single-currency scope and can reuse the time output in summary formulas", () => {
    const sourceColumns = [
      ...columns.map((column) =>
        column.id === "amount"
          ? { ...column, unit: { kind: "money", currencyColumn: "currency" } }
          : column,
      ),
      { id: "currency", type: "currency" },
    ];
    const sourceRows = rows.map((row) => ({ ...row, currency: "EUR" }));
    const output = compareAnalysisTime({
      rows: sourceRows,
      columns: sourceColumns,
      dateColumn: "date",
      valueColumns: ["amount"],
      missing: "zero",
    });
    expect(
      output.columns.find((column) => column.id === "amount")!.unit,
    ).toEqual({ kind: "money", currency: "EUR" });
    expect(
      output.columns.find((column) => column.id === "amount_previous")!.unit,
    ).toEqual({ kind: "money", currency: "EUR" });
    const formula = evaluateAnalysisFormulas({
      rows: output.rows,
      columns: output.columns,
      formulas: [{ id: "total", scope: "summary", expression: "SUM(amount)" }],
    });
    expect(formula.summaries.total).toBe("40");
    expect(formula.formulaUnits.total).toEqual({
      kind: "money",
      currency: "EUR",
    });
    const pivot = prepareAnalysisData({
      rows: sourceRows,
      columns: sourceColumns,
      steps: [
        {
          type: "pivot",
          groupColumns: ["category"],
          nameColumn: "date",
          valueColumn: "amount",
        },
      ],
    });
    expect(
      pivot.columns.find((column) => column.id === "pivot_0")!.unit,
    ).toEqual({ kind: "money", currency: "EUR" });
  });
  it("resolves omitted single-instrument scope without inventing an identity", () => {
    const output = compareAnalysisTime({
      rows: [{ date: "2024-01-01", units: "10", investment_id: 7 }],
      columns: [
        { id: "date", type: "date" },
        {
          id: "units",
          type: "decimal",
          unit: { kind: "quantity", instrumentColumn: "investment_id" },
        },
        { id: "investment_id", type: "integer" },
      ],
      dateColumn: "date",
      valueColumns: ["units"],
    });
    expect(
      output.columns.find((column) => column.id === "units")!.unit,
    ).toEqual({ kind: "quantity", instrumentId: "7" });
    const formula = evaluateAnalysisFormulas({
      rows: output.rows,
      columns: output.columns,
      formulas: [{ id: "total", scope: "summary", expression: "SUM(units)" }],
    });
    expect(formula.summaries.total).toBe("10");
  });
});

it("rejects calendar output collisions and gives pivots count units", () => {
  expect(() =>
    compareAnalysisTime({
      rows: [{ date: "2024-01-01", amount: "10", amount_previous: "99" }],
      columns: [...columns, { id: "amount_previous", type: "decimal" }],
      dateColumn: "date",
      valueColumns: ["amount", "amount_previous"],
    }),
  ).toThrow(/collide/);
  const output = prepareAnalysisData({
    rows,
    columns,
    steps: [
      {
        type: "pivot",
        nameColumn: "category",
        valueColumn: "amount",
        aggregate: "count",
      },
    ],
  });
  expect(output.rows).toEqual([{ pivot_0: "2" }]);
  expect(output.columns[0]).toMatchObject({
    type: "integer",
    unit: { kind: "count" },
  });
});
it("binds imported monetary values to imported currency", () => {
  const output = prepareAnalysisData({
    rows: [{ category: "A", currency: "EUR" }],
    columns: [
      { id: "category", type: "string" },
      { id: "currency", type: "currency" },
    ],
    steps: [
      {
        type: "lookup",
        resultColumn: "category",
        inputColumn: "category",
        input: {
          rows: [{ category: "A", amount: "12", currency: "USD" }],
          columns: [
            { id: "category", type: "string" },
            {
              id: "amount",
              type: "decimal",
              unit: { kind: "money", currencyColumn: "currency" },
            },
            { id: "currency", type: "currency" },
          ],
        },
      },
    ],
  });
  expect(
    output.columns.find((c) => c.id === "input.amount")!.unit!.currencyColumn,
  ).toBe("input.currency");
  expect(output.rows[0]["input.currency"]).toBe("USD");
});
