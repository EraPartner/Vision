import { describe, expect, it } from "vitest";
import type { AnalysisDataset, AnalysisResult } from "@/lib/api/analysis";
import nl from "@/locales/nl";
import {
    analysisCatalogLabel,
    analysisColumnLabel,
    formatAnalysisValue,
} from "./analysisPresentation";

const t = (key: string) => nl[key] ?? key;
const datasets = [
    {
        fields: [{ id: "month", label: "Month" }],
        measures: [{ id: "sum_spending", label: "Spending" }],
    },
] as AnalysisDataset[];
const result = { declaredColumns: [] } as unknown as AnalysisResult;

describe("analysis presentation", () => {
    it("translates catalog labels while preserving unknown labels and explicit aliases", () => {
        expect(analysisCatalogLabel("Cash flows", t)).toBe("Kasstromen");
        expect(analysisColumnLabel(result, "sum_spending", datasets, t)).toBe(
            "Uitgaven",
        );
        expect(analysisColumnLabel(result, "sum_spending", [], t)).toBe(
            "sum_spending",
        );
        expect(analysisColumnLabel(result, "my_total", datasets, t)).toBe(
            "my_total",
        );
        const custom = {
            ...result,
            declaredColumns: [
                {
                    id: "sum_spending",
                    label: "My household spending",
                    type: "decimal",
                    nullable: false,
                },
            ],
        };
        expect(analysisColumnLabel(custom, "sum_spending", datasets, t)).toBe(
            "My household spending",
        );
        expect(
            analysisColumnLabel(
                {
                    ...custom,
                    declaredColumns: [
                        { ...custom.declaredColumns[0], label: "Spending" },
                    ],
                },
                "sum_spending",
                datasets,
                t,
            ),
        ).toBe("Uitgaven");
    });
    it.each([
        ["eu", "1.234,5600"],
        ["us", "1,234.5600"],

        ["in", "1,234.5600"],
    ])(
        "uses %s separators without losing decimal precision",
        (format, expected) => {
            expect(
                formatAnalysisValue(
                    "1234.5600",
                    "decimal",
                    "sum_spending",
                    format,
                ),
            ).toBe(expected);
        },
    );
    it("uses the platform Swiss grouping separator", () => {
        expect(
            formatAnalysisValue("1234.5600", "decimal", "total", "ch"),
        ).toMatch(/^1['’]234\.5600$/);
    });
    it("keeps dates, identifiers, and numeric-looking text unchanged", () => {
        expect(formatAnalysisValue("2026-09-01", "date", "month", "eu")).toBe(
            "2026-09-01",
        );
        expect(
            formatAnalysisValue("001234", "integer", "account_id", "eu"),
        ).toBe("001234");
        expect(formatAnalysisValue("001234", "string", "reference", "eu")).toBe(
            "001234",
        );
        expect(formatAnalysisValue("EUR", "currency", "currency", "eu")).toBe(
            "EUR",
        );
    });
    it("preserves large decimals, signs, nulls, and zero", () => {
        expect(
            formatAnalysisValue(
                "-9007199254740993.123456789",
                "decimal",
                "total",
                "eu",
            ),
        ).toBe("-9.007.199.254.740.993,123456789");
        expect(formatAnalysisValue(0, "integer", "count", "eu")).toBe("0");
        expect(formatAnalysisValue(null, "decimal", "total", "eu")).toBe("—");
    });
});
