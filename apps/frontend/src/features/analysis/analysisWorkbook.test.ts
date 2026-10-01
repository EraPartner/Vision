// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import type { AnalysisResult } from "@/lib/api/analysis";
import {
    analysisResultWorkbook,
    importAnalysisWorkbook,
} from "./analysisWorkbook";
const fixture = {
    requestId: "run",
    completedAt: "2026-09-30T10:00:00Z",
    columns: [
        { id: "date", type: "date" },
        { id: "amount", type: "decimal" },
        { id: "precise", type: "decimal" },
        { id: "note", type: "string" },
        { id: "active", type: "boolean" },
    ],
    rows: [
        {
            date: "2026-09-30",
            amount: "-12.30",
            precise: "1234567890123456.78",
            note: '=HYPERLINK("x") & <tag>',
            active: true,
        },
        { date: null, amount: null, precise: null, note: null, active: null },
    ],
    window: {
        kind: "page",
        offset: 0,
        hasMore: false,
        limit: 500,
        returnedRows: 2,
    },
} as unknown as AnalysisResult;
describe("typed XLSX interchange", () => {
    it("exports summary outcomes without colliding with the styles relationship", () => {
        const bytes = analysisResultWorkbook(
            {
                ...fixture,
                formulaSummaries: {
                    total: "123.45",
                    unavailable: null,
                    exact: "1234567890123456.78",
                },
            },
            { name: "Summary", workspace: "budgeting", timezone: "UTC" },
        );
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain('name="Summary results"');
        expect(text).toContain('<c r="B2"><v>123.45</v></c>');
        expect(text).toContain(
            '<c r="B4" t="inlineStr"><is><t xml:space="preserve">1234567890123456.78</t></is></c>',
        );
        expect(text).toContain(
            'Id="rId6" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
        );
    });
    it("builds valid stored ZIP workbook and round trips calendar dates and exact long decimals", () => {
        const bytes = analysisResultWorkbook(fixture, {
            name: "Test",
            workspace: "budgeting",
            timezone: "Europe/Helsinki",
            assumptions: { rate: "0.1" },
            formulas: [{ expression: "amount * rate" }],
        });
        expect(new DataView(bytes.buffer).getUint32(0, true)).toBe(0x04034b50);
        const text = new TextDecoder().decode(bytes);
        expect(text).toContain('name="Formula definitions"');
        expect(text).toContain("15 significant digits");
        expect(text).not.toContain("<f>");
        expect(text).toContain("&amp; &lt;tag&gt;");
        const imported = importAnalysisWorkbook(bytes);
        expect(imported.rows[0]).toEqual({
            date: "2026-09-30",
            amount: -12.3,
            precise: "1234567890123456.78",
            note: '=HYPERLINK("x") & <tag>',
            active: true,
        });
        expect(imported.rows[1].amount).toBeNull();
        expect(imported.formulaCells).toBe(0);
    });
    it("rejects oversized or malformed import", () => {
        expect(() => importAnalysisWorkbook(new Uint8Array(10000001))).toThrow(
            "10 MB",
        );
        expect(() => importAnalysisWorkbook(new Uint8Array(20))).toThrow(
            "missing",
        );
    });
});
it("handles Excel's 1900 leap-year compatibility and typed assumptions", () => {
    const bytes = analysisResultWorkbook(
        {
            ...fixture,
            rows: [
                { date: "1900-01-01", amount: "1" },
                { date: "1900-03-01", amount: "2" },
            ],
        },
        {
            name: "Historic",
            timezone: "UTC",
            workspace: "research",
            assumptions: {
                definitions: [
                    { id: "rate", label: "Rate", defaultValue: "0.1" },
                ],
                values: { rate: "0.25" },
            },
        },
    );
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('<c r="A2" s="1"><v>1</v></c>');
    expect(text).toContain('<c r="A3" s="1"><v>61</v></c>');
    expect(text).toContain('<c r="C2"><v>0.25</v></c>');
    expect(importAnalysisWorkbook(bytes).rows.map((r) => r.date)).toEqual([
        "1900-01-01",
        "1900-03-01",
    ]);
});
it("restores stable source identifiers rather than user-facing header labels", () => {
    const result = {
        ...fixture,
        declaredColumns: [
            {
                id: "flow",
                label: "Net cash flow",
                type: "decimal",
                nullable: true,
            },
        ],
        rows: [{ flow: "12.30" }],
    };
    const imported = importAnalysisWorkbook(
        analysisResultWorkbook(result, {
            name: "Label",
            timezone: "UTC",
            workspace: "budgeting",
        }),
    );
    expect(imported.columns).toEqual(["flow"]);
    expect(imported.rows[0]).toEqual({ flow: 12.3 });
});

it("exports value completeness and error lineage independently of row pagination", () => {
    const bytes = analysisResultWorkbook(
        {
            ...fixture,
            complete: false,
            coverage: {
                complete: false,
                status: "partial",
                unavailableRows: 1,
                sourceRows: 2,
            },
            transformationCoverage: [{ complete: false, operation: "convert" }],
            preparationLineage: [{ step: "date conversion" }],
            transformationErrors: [{ message: "Invalid date" }],
            formulaErrors: [
                {
                    formulaId: "total",
                    code: "INCOMPLETE",
                    message: "Unavailable contributor",
                },
            ],
        },
        { name: "Partial", workspace: "research", timezone: "UTC" },
    );
    const text = new TextDecoder().decode(bytes);
    for (const key of [
        "complete",
        "financialCoverage",
        "transformationCoverage",
        "preparationLineage",
        "transformationErrors",
        "formulaErrors",
        "Invalid date",
        "Unavailable contributor",
        "unavailableRows",
    ]) {
        expect(text).toContain(key);
    }
    expect(text).toContain("&quot;status&quot;:&quot;partial&quot;");
    expect(text).toContain("&quot;kind&quot;:&quot;page&quot;");
    expect(importAnalysisWorkbook(bytes).rows).toHaveLength(2);
});
