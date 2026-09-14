import { describe, expect, it, vi } from "vitest";
import { analysisResultCsv, parseScenarioCsv } from "./analysisInterchange";

describe("analysis CSV interchange", () => {
    it("exports reproducibility metadata and neutralizes formula payloads", () => {
        const csv = analysisResultCsv(
            {
                requestId: "analysis-test",
                startedAt: "2026-09-14T09:59:59Z",
                completedAt: "2026-09-14T10:00:00Z",
                executor: "postgresql-role-v1",
                rows: [
                    {
                        label: "=CMD()",
                        amount: "-12.34",
                        "scenario.rate": "+10%",
                    },
                ],
                columns: [
                    { id: "label", type: "string" },
                    { id: "amount", type: "decimal" },
                ],
                generatedSql: "redacted",
                byteLength: 10,
                window: {
                    kind: "truncated",
                    returnedRows: 1,
                    enforcedLimit: 1,
                    reason: "byte-limit",
                },
            },
            {
                name: "Scenario",
                timezone: "Europe/Helsinki",
                workspace: "budgeting",
                definitionId: "analysis:test",
                definitionVersion: 2,
                datasetIds: ["cash-flows"],
                sourceReferences: ["Synthetic Demo ledger"],
            },
        );
        expect(csv).toContain("# definition_id,analysis:test");
        expect(csv).toContain("# definition_version,2");
        expect(csv).toContain("# request_id,analysis-test");
        expect(csv).toContain("# datasets,cash-flows");
        expect(csv).toContain("# source_references,Synthetic Demo ledger");
        expect(csv).toContain("label:string:unit-unavailable");
        expect(csv).toContain(
            "scenario.rate:string:unit-unavailable:runtime-inferred",
        );
        expect(csv).toContain("# source_versions,unavailable");
        expect(csv).toContain("# result_window,truncated:byte-limit");
        expect(csv).toContain("'=CMD(),-12.34");
        expect(csv).toContain("scenario.rate");
        expect(csv).toContain("'+10%");
        expect(csv).not.toContain("redacted");
        expect(csv).not.toContain("reporting_currency");
    });

    it("parses typed value-only CSV and hashes its exact source", async () => {
        vi.stubGlobal("crypto", {
            subtle: {
                digest: vi
                    .fn()
                    .mockResolvedValue(new Uint8Array(32).fill(1).buffer),
            },
        });
        const attachment = await parseScenarioCsv(
            new File(["Plan,Cost,Enabled\nA,40.5,true\n"], "options.csv", {
                type: "text/csv",
            }),
        );
        expect(attachment.columns.map(({ type }) => type)).toEqual([
            "string",
            "decimal",
            "boolean",
        ]);
        expect(attachment.rows[0]).toEqual({
            plan: "A",
            cost: "40.5",
            enabled: true,
        });
        expect(attachment.sha256).toHaveLength(64);
        vi.unstubAllGlobals();
    });

    it("preserves unsafe integer text instead of rounding it", async () => {
        vi.stubGlobal("crypto", {
            subtle: {
                digest: vi
                    .fn()
                    .mockResolvedValue(new Uint8Array(32).fill(1).buffer),
            },
        });
        const attachment = await parseScenarioCsv(
            new File(["Account\n9007199254740993\n"], "ids.csv", {
                type: "text/csv",
            }),
        );
        expect(attachment.columns[0].type).toBe("string");
        expect(attachment.rows[0].account).toBe("9007199254740993");
        vi.unstubAllGlobals();
    });
});
