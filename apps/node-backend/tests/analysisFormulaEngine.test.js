import { describe, expect, it } from "vitest";
import { evaluateAnalysisFormulas } from "../src/services/analysisFormulaEngine.js";

describe("analysisFormulaEngine", () => {
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
