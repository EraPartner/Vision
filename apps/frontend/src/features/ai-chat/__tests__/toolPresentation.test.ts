import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import {
    toolResultAxes,
    toolResultColumns,
    toolResultPresentation,
    toolResultRows,
} from "@vision/shared-utils/ai-chat/toolPresentation";
const require = createRequire(import.meta.url);
const { computePieSectors, defaultPieProps } =
    require("recharts/lib/polar/Pie.js") as {
        computePieSectors: (
            input: Record<string, unknown>,
        ) =>
            | Array<{
                  name: string;
                  value: number;
                  percent: number;
                  startAngle: number;
                  endAngle: number;
              }>
            | undefined;
        defaultPieProps: Record<string, unknown>;
    };
describe("Tool result source inference and Recharts composition", () => {
    it("retains first row member order, numeric key order and nested arrays", () => {
        const rows = toolResultRows([
            null,
            2,
            "x",
            { name: "first", gain: 3, amount: "9" },
            ["nested", 4],
            { later: 10 },
        ]);
        expect(rows).toHaveLength(3);
        expect(toolResultColumns(rows)).toEqual(["name", "gain", "amount"]);
        expect(toolResultAxes(rows)).toEqual({ xk: "name", yk: ["gain"] });
        expect(
            toolResultColumns(toolResultRows({ z: 3, "2": 2, "0": 0, a: 1 })),
        ).toEqual(["0", "2", "z", "a"]);
        expect(toolResultColumns(toolResultRows([["x", 4]]))).toEqual([
            "0",
            "1",
        ]);
    });
    it("explicit empty x key and nonempty preferred arrays take precedence", () => {
        const rows = [{ name: "x", a: 2, b: 3 }];
        expect(toolResultAxes(rows, "", ["b", "a"])).toEqual({
            xk: "",
            yk: ["b", "a"],
        });
        expect(toolResultAxes(rows, undefined, [])).toEqual({
            xk: "name",
            yk: ["a", "b"],
        });
        expect(toolResultColumns(rows, ["missing", "a"])).toEqual([
            "missing",
            "a",
        ]);
    });
    it.each([
        [2, 3],
        [4, -1],
        [0, 4],
        [-2, -3],
        [0, 0],
        [1e308, 1e308],
    ])(
        "matches actual installed Recharts sectors for %j",
        (...values: number[]) => {
            const data = values.map((value, index) => ({
                name: `r${index}`,
                value,
            }));
            const actual = computePieSectors({
                pieSettings: {
                    ...defaultPieProps,
                    cx: "50%",
                    cy: "50%",
                    innerRadius: 40,
                    outerRadius: 80,
                },
                displayedData: data,
                cells: [],
                offset: { top: 0, left: 0, width: 300, height: 224 },
            });
            const result = toolResultPresentation({
                ok: true,
                data,
                meta: { renderAs: "pie" },
            })!;
            expect(result.pieRenderable).toBe((actual?.length ?? 0) > 0);
            expect(result.pieRows).toEqual(
                (actual ?? []).map(
                    ({ name, value, percent, startAngle, endAngle }) => ({
                        name,
                        value,
                        percent,
                        labelPercent: percent * 100,
                        startAngle,
                        endAngle,
                    }),
                ),
            );
        },
    );
    it("uses JS label coercion and zero for explicit non-number pie values", () => {
        const result = toolResultPresentation({
            ok: true,
            data: [
                { label: { x: 1 }, value: 2 },
                { label: ["a", "b"], value: "3" },
                { label: null, value: 1 },
            ],
            meta: { renderAs: "pie", xKey: "label", yKeys: ["value"] },
        })!;
        expect(result.pieRows.map((r) => [r.name, r.value])).toEqual([
            ["[object Object]", 2],
            ["a,b", 0],
            ["", 1],
        ]);
    });
    it("raw results remain unchanged and ignored xField/yField keep source inference", () => {
        const input = {
            ok: true,
            data: [{ first: 1, second: 2 }],
            meta: { xField: "second", yField: "first" },
        };
        const before = JSON.stringify(input);
        expect(toolResultPresentation(input)).toMatchObject({
            renderAs: "table",
            columns: ["first", "second"],
            xKey: "first",
            yKeys: ["second"],
            rowCount: 1,
        });
        expect(JSON.stringify(input)).toBe(before);
        expect(
            toolResultPresentation({ ok: false, data: [{ secret: 2 }] }),
        ).toMatchObject({ rows: [], columns: [], renderAs: "json" });
        expect(toolResultPresentation({ ok: true, data: "raw" })).toMatchObject(
            { renderAs: "json", rowCount: 0 },
        );
    });
});
