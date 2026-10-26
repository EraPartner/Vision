import { describe, expect, it } from "vitest";
import {
    savedFormulaModel,
    savedPivotConfig,
    savedScenarioModel,
    sourceFromSaved,
} from "@/features/analysis/savedAnalysisState";
import type { SavedAnalysis } from "@/lib/api/analysis";

const saved = (source: unknown): SavedAnalysis =>
    // Only `definition.source` is read by sourceFromSaved.
    ({ definition: { source } }) as unknown as SavedAnalysis;

describe("sourceFromSaved", () => {
    it("rebuilds a visual plan from a stored visual-plan source", () => {
        const result = sourceFromSaved(
            saved({
                kind: "visual-plan",
                datasetId: "transactions",
                select: [
                    { id: "date", source: { kind: "field" } },
                    { id: "total", source: { kind: "metric" } },
                ],
                filters: [
                    {
                        left: { datasetId: "accounts", columnId: "name" },
                        operator: "eq",
                        right: { kind: "literal", value: "ING" },
                    },
                ],
                groupBy: ["date"],
                joins: [{ pathId: "tx-account" }],
                orderBy: [{ outputId: "total", direction: "desc" }],
                limit: 25,
            }),
        );
        expect(result).toEqual({
            mode: "visual",
            plan: {
                datasetId: "transactions",
                fields: ["date"],
                measures: ["total"],
                filters: [
                    { fieldId: "account.name", operator: "eq", value: "ING" },
                ],
                groups: ["date"],
                joins: ["tx-account"],
                orderBy: [{ id: "total", direction: "desc" }],
                limit: 25,
            },
        });
    });

    it("falls back to an empty SQL source for a missing or malformed source", () => {
        for (const source of [undefined, null, "x", 3]) {
            expect(sourceFromSaved(saved(source))).toMatchObject({
                mode: "sql",
                sql: "",
                datasetIds: [],
            });
        }
    });

    it("tolerates malformed entries inside a visual plan instead of throwing", () => {
        const result = sourceFromSaved(
            saved({
                kind: "visual-plan",
                datasetId: "d",
                select: [null, 7, { id: "a" }],
                filters: "nope",
                groupBy: [1, "g"],
                joins: [{ pathId: 4 }],
            }),
        );
        expect(result.plan).toMatchObject({
            fields: [],
            filters: [],
            groups: ["g"],
            joins: [],
            limit: 500,
        });
    });
});

describe("saved parameter readers", () => {
    it("defaults a malformed scenario model and formula model", () => {
        expect(savedScenarioModel("x")).toEqual({ attachments: [], joins: [] });
        expect(savedFormulaModel(null)).toEqual({
            formulas: [],
            assumptions: [],
            assumptionValues: {},
        });
    });

    it("keeps a well-formed pivot config and rejects a non-object", () => {
        expect(
            savedPivotConfig({ rows: ["a"], columns: [], values: ["v"] }),
        ).toEqual({ rows: ["a"], columns: [], values: ["v"], filters: [] });
        expect(savedPivotConfig(5)).toBeUndefined();
    });
});
