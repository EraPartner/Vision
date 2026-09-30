import { describe, expect, it } from "vitest";
import { evaluateAnalysisFormulas } from "../src/services/analysisFormulaEngine.js";

describe("analysisFormulaEngine", () => {
  it("rejects mixed-currency numeric aggregates, including derived columns", () => {
    const result = evaluateAnalysisFormulas({
      rows: [
        { currency: "EUR", sum_amount: "10" },
        { currency: "USD", sum_amount: "20" },
      ],
      formulas: [
        { id: "derived", scope: "row", expression: "sum_amount * 2" },
        ...["SUM", "AVERAGE", "MIN", "MAX"].map((fn) => ({
          id: fn.toLowerCase(),
          scope: "summary",
          expression: `${fn}(formula.derived)`,
        })),
        {
          id: "conditional",
          scope: "summary",
          expression: 'SUMIF(sum_amount, ">", 0, formula.derived)',
        },
        { id: "count", scope: "summary", expression: "COUNT(sum_amount)" },
        {
          id: "countif",
          scope: "summary",
          expression: 'COUNTIF(sum_amount, ">", 0)',
        },
        {
          id: "eur",
          scope: "summary",
          expression: 'SUMIF(currency, "==", "EUR", formula.derived)',
        },
      ],
    });
    expect(result.errors).toHaveLength(5);
    expect(result.errors.every(({ code }) => code === "MIXED_CURRENCIES")).toBe(
      true,
    );
    expect(result.summaries).toEqual({
      sum: null,
      average: null,
      min: null,
      max: null,
      conditional: null,
      count: 2,
      countif: 2,
      eur: "20",
    });
  });

  it("allows same-currency and metadata-free aggregates and ignores null contributions", () => {
    for (const currencies of [
      ["EUR", "EUR"],
      [undefined, undefined],
    ]) {
      const result = evaluateAnalysisFormulas({
        rows: [
          { currency: currencies[0], value: "10" },
          { currency: currencies[1], value: "20" },
          { currency: "USD", value: null },
        ],
        formulas: [{ id: "total", scope: "summary", expression: "SUM(value)" }],
      });
      expect(result.complete).toBe(true);
      expect(result.summaries.total).toBe("30");
    }
  });

  it("blocks aggregates over incomplete input and propagates their errors", () => {
    const result = evaluateAnalysisFormulas({
      rows: [{ value: "2" }],
      inputComplete: false,
      formulas: [
        { id: "local", scope: "row", expression: "value * 2" },
        { id: "row_total", scope: "row", expression: "SUM(value)" },
        {
          id: "row_dependent",
          scope: "row",
          expression: "formula.row_total + 1",
        },
        { id: "total", scope: "summary", expression: "COUNT(value)" },
        { id: "dependent", scope: "summary", expression: "formula.total + 1" },
      ],
    });
    expect(result.complete).toBe(false);
    expect(result.rows[0]).toMatchObject({
      local: "4",
      row_total: null,
      row_dependent: null,
    });
    expect(result.summaries).toEqual({ total: null, dependent: null });
    expect(result.errors.map(({ code }) => code)).toEqual([
      "INCOMPLETE_INPUT",
      "DEPENDENCY_ERROR",
      "INCOMPLETE_INPUT",
      "DEPENDENCY_ERROR",
    ]);
  });

  it("treats numeric zero conditions as false and evaluates only the selected branch", () => {
    const result = evaluateAnalysisFormulas({
      rows: [{ value: "0.00" }, { value: "-2" }, { value: 0 }, { value: true }],
      formulas: [
        { id: "literal", scope: "row", expression: "IF(0, 1 / 0, 2)" },
        { id: "computed", scope: "row", expression: "IF(1 - 1, 1, 2)" },
        { id: "column", scope: "row", expression: "IF(value, 1, 2)" },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.rows.map((row) => row.literal)).toEqual(["2", "2", "2", "2"]);
    expect(result.rows.map((row) => row.computed)).toEqual([
      "2",
      "2",
      "2",
      "2",
    ]);
    expect(result.rows.map((row) => row.column)).toEqual(["2", "1", "2", "1"]);
  });

  it("isolates row errors and propagates them without reporting incomplete totals", () => {
    const result = evaluateAnalysisFormulas({
      rows: [{ value: "2" }, { value: "0" }, { value: "4" }],
      formulas: [
        { id: "inverse", scope: "row", expression: "1 / value" },
        { id: "dependent", scope: "row", expression: "formula.inverse * 2" },
        { id: "total", scope: "summary", expression: "SUM(formula.inverse)" },
        { id: "next_total", scope: "summary", expression: "formula.total + 1" },
        { id: "independent", scope: "summary", expression: "SUM(value)" },
        {
          id: "guarded",
          scope: "row",
          expression: "IF(value == 0, 0, formula.inverse)",
        },
      ],
    });
    expect(result.complete).toBe(false);
    expect(result.rows.map((row) => row.inverse)).toEqual([
      "0.5",
      null,
      "0.25",
    ]);
    expect(result.rows.map((row) => row.dependent)).toEqual(["1", null, "0.5"]);
    expect(result.rows.map((row) => row.guarded)).toEqual(["0.5", "0", "0.25"]);
    expect(result.summaries).toEqual({
      total: null,
      next_total: null,
      independent: "6",
    });
    expect(result.errors).toEqual([
      expect.objectContaining({
        formulaId: "inverse",
        rowIndex: 1,
        code: "DIVIDE_BY_ZERO",
      }),
      expect.objectContaining({
        formulaId: "dependent",
        rowIndex: 1,
        code: "DEPENDENCY_ERROR",
      }),
      expect.objectContaining({ formulaId: "total", code: "DEPENDENCY_ERROR" }),
      expect.objectContaining({
        formulaId: "next_total",
        code: "DEPENDENCY_ERROR",
      }),
    ]);
  });

  it("uses decimal arithmetic, assumptions, conditionals, dates, and summaries", () => {
    const result = evaluateAnalysisFormulas({
      rows: [
        { category: "Rent", amount: "1000.10", booked: "2026-01-31" },
        { category: "Food", amount: "20.20", booked: "2026-02-01" },
      ],
      assumptions: { inflation: "0.03" },
      formulas: [
        {
          id: "inflated",
          scope: "row",
          expression: "amount * (1 + assumption.inflation)",
        },
        {
          id: "excluded",
          scope: "row",
          expression: 'IF(category == "Rent", 0, formula.inflated)',
        },
        { id: "next_date", scope: "row", expression: "DATEADD(booked, 1)" },
        { id: "total", scope: "summary", expression: "SUM(formula.excluded)" },
        {
          id: "food_count",
          scope: "summary",
          expression: 'COUNTIF(category, "==", "Food")',
        },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.rows[0]).toMatchObject({
      inflated: "1030.103",
      excluded: "0",
      next_date: "2026-02-01",
    });
    expect(result.rows[1].inflated).toBe("20.806");
    expect(result.summaries).toEqual({ total: "20.806", food_count: 1 });
  });

  it("reports cycles and broken references without executing code", () => {
    expect(() =>
      evaluateAnalysisFormulas({
        rows: [{}],
        formulas: [
          { id: "a", scope: "row", expression: "formula.b + 1" },
          { id: "b", scope: "row", expression: "formula.a + 1" },
        ],
      }),
    ).toThrow(/cycle/i);
    const result = evaluateAnalysisFormulas({
      rows: [{ amount: "2" }],
      formulas: [{ id: "bad", scope: "row", expression: "missing + 1" }],
    });
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toMatchObject({
      formulaId: "bad",
      code: "BROKEN_REFERENCE",
    });
    expect(result.rows[0].bad).toBeNull();
  });

  it("rejects JavaScript, macros, and network-shaped syntax", () => {
    for (const expression of [
      "globalThis.process",
      'fetch("https://example.com")',
      "amount; DROP TABLE x",
      'new Function("x")',
    ]) {
      const run = () =>
        evaluateAnalysisFormulas({
          rows: [{ amount: "1" }],
          formulas: [{ id: "unsafe", scope: "row", expression }],
        });
      try {
        const result = run();
        expect(result.complete).toBe(false);
        expect(result.errors[0]?.code).toBe("BROKEN_REFERENCE");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
      }
    }
  });

  it("rejects nested aggregates before evaluating the row set", () => {
    expect(() =>
      evaluateAnalysisFormulas({
        rows: [{ amount: "1" }],
        formulas: [
          {
            id: "unsafe_work",
            scope: "summary",
            expression: "SUM(AVERAGE(amount))",
          },
        ],
      }),
    ).toThrow(/cannot be nested/i);
  });

  it("keeps exact decimal comparison semantics", () => {
    const result = evaluateAnalysisFormulas({
      rows: [{}],
      formulas: [
        {
          id: "exact",
          scope: "row",
          expression: "(9007199254740992 + 1) == 9007199254740992",
        },
      ],
    });
    expect(result.complete).toBe(true);
    expect(result.rows[0].exact).toBe(false);
  });

  it("rejects calendar dates that JavaScript would silently normalize", () => {
    const result = evaluateAnalysisFormulas({
      rows: [{}],
      formulas: [
        {
          id: "invalid_date",
          scope: "row",
          expression: 'DATEADD("2026-02-30", 1)',
        },
      ],
    });
    expect(result.complete).toBe(false);
    expect(result.errors[0]).toMatchObject({ code: "TYPE_ERROR" });
  });
});
