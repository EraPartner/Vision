import { describe, it, expect } from "vitest";
import type { AnalysisResult } from "@/lib/api/analysis";
import {
    analysisChartData,
    normalizeAnalysisChartSpec,
} from "./analysisChartModel";
const fixture = {
    columns: [{ id: "amount", type: "decimal" }],
    rows: [
        { month: "Jan", amount: "-12.3", currency: "EUR" },
        { month: "Feb", amount: null, currency: "EUR" },
    ],
    window: {
        kind: "page",
        offset: 0,
        hasMore: false,
        limit: 500,
        returnedRows: 2,
    },
} as unknown as AnalysisResult;
describe("analysis chart coverage", () => {
    it("normalizes legacy binding and keeps signed/missing values", () => {
        const spec = normalizeAnalysisChartSpec({
            kind: "bar",
            x: "month",
            y: "amount",
        });
        expect(spec.y).toEqual(["amount"]);
        const d = analysisChartData(fixture, spec);
        expect(d.rows[0].values).toEqual([-12.3]);
        expect(d.rows[1].values).toEqual([null]);
        expect(d.omitted).toBe(1);
        expect(d.complete).toBe(true);
    });
    it("rejects partial pages and incompatible currencies", () => {
        expect(
            analysisChartData(
                {
                    ...fixture,
                    window: {
                        kind: "page",
                        offset: 500,
                        hasMore: false,
                        limit: 500,
                        returnedRows: 2,
                    },
                },
                normalizeAnalysisChartSpec({ x: "month", y: "amount" }),
            ).complete,
        ).toBe(false);
        expect(
            analysisChartData(
                {
                    ...fixture,
                    rows: [...fixture.rows, { amount: 20, currency: "USD" }],
                },
                normalizeAnalysisChartSpec({ x: "month", y: "amount" }),
            ).incompatible,
        ).toBe(true);
    });
    it("does not use booleans or blanks as numeric scatter coordinates", () => {
        const d = analysisChartData(
            { ...fixture, rows: [{ month: false, amount: "" }] },
            { kind: "scatter", x: "month", y: ["amount"] },
        );
        expect(d.omitted).toBe(1);
        expect(d.rows[0].values[0]).toBeNull();
    });
});
it("compares dimensional unit values and rejects missing currency provenance", () => {
    const spec = { kind: "bar" as const, x: "month", y: ["a", "b"] };
    const result = {
        ...fixture,
        columns: [
            {
                id: "a",
                type: "decimal",
                unit: { kind: "money", currency: "EUR" },
            },
            {
                id: "b",
                type: "decimal",
                unit: { kind: "money", currency: "EUR" },
            },
        ],
        rows: [{ month: "Jan", a: "1", b: "2" }],
    } as AnalysisResult;
    expect(analysisChartData(result, spec).incompatible).toBe(false);
    expect(
        analysisChartData(
            {
                ...result,
                columns: [
                    {
                        id: "a",
                        type: "decimal",
                        unit: { kind: "money", currencyColumn: "currency" },
                    },
                    {
                        id: "b",
                        type: "decimal",
                        unit: { kind: "money", currencyColumn: "currency" },
                    },
                ],
            },
            spec,
        ).incompatible,
    ).toBe(true);
});
it("matches fixed and column-resolved currency scope and withholds missing instrument scope", () => {
    const r = {
        ...fixture,
        rows: [{ month: "Jan", a: "1", b: "2", currency: "EUR" }],
        columns: [
            {
                id: "a",
                type: "decimal",
                unit: { kind: "money", currency: "EUR" },
            },
            {
                id: "b",
                type: "decimal",
                unit: { kind: "money", currencyColumn: "currency" },
            },
        ],
    } as AnalysisResult;
    expect(
        analysisChartData(r, { kind: "bar", x: "month", y: ["a", "b"] })
            .incompatible,
    ).toBe(false);
    expect(
        analysisChartData(
            {
                ...r,
                columns: [
                    {
                        id: "a",
                        type: "decimal",
                        unit: {
                            kind: "quantity",
                            instrumentColumn: "investment_id",
                        },
                    },
                ],
            },
            { kind: "bar", x: "month", y: ["a"] },
        ).incompatible,
    ).toBe(true);
});

it("withholds charts for unavailable contributors without changing source pagination", () => {
    const spec = normalizeAnalysisChartSpec({ x: "month", y: "amount" });
    for (const metadata of [
        { complete: false },
        { coverage: { complete: false, status: "partial" } },
        { transformationCoverage: [{ complete: false }] },
        { transformationErrors: [{ message: "Invalid date" }] },
    ]) {
        const partial = { ...fixture, ...metadata };
        expect(analysisChartData(partial, spec).complete).toBe(false);
        expect(partial.window).toEqual(fixture.window);
    }
});
