import { describe, expect, it } from "vitest";
import {
    toolResultAxes,
    toolResultColumns,
    toolResultPresentation,
    toolResultRows,
} from "@vision/shared-utils/ai-chat/toolPresentation";
import { must } from "@/test/must";
/**
 * Sectors recharts 3.10.1 computed for these inputs (computePieSectors with
 * cx/cy 50%, radii 40/80, 300x224) before recharts was removed (ADR-245). The
 * server's pie rows keep that contract.
 */
const RECHARTS_SECTORS: ReadonlyArray<
    readonly [
        number[],
        Array<{
            name: string;
            value: number;
            percent: number;
            startAngle: number;
            endAngle: number;
        }>,
    ]
> = [
    [
        [2, 3],
        [
            { name: "r0", value: 2, percent: 0.4, startAngle: 0, endAngle: 144 },
            { name: "r1", value: 3, percent: 0.6, startAngle: 144, endAngle: 360 },
        ],
    ],
    [
        [4, -1],
        [
            { name: "r0", value: 4, percent: 1.3333333333333333, startAngle: 0, endAngle: 480 },
            { name: "r1", value: -1, percent: -0.3333333333333333, startAngle: 480, endAngle: 360 },
        ],
    ],
    [
        [0, 4],
        [
            { name: "r0", value: 0, percent: 0, startAngle: 0, endAngle: 0 },
            { name: "r1", value: 4, percent: 1, startAngle: 0, endAngle: 360 },
        ],
    ],
    [[-2, -3], []],
    [[0, 0], []],
    [
        [1e308, 1e308],
        [
            { name: "r0", value: 1e308, percent: 0, startAngle: 0, endAngle: 0 },
            { name: "r1", value: 1e308, percent: 0, startAngle: 0, endAngle: 0 },
        ],
    ],
];
describe("Tool result source inference and pie composition", () => {
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
    it.each(RECHARTS_SECTORS)(
        "matches the recharts sectors recorded for %j",
        (values, sectors) => {
            const data = values.map((value, index) => ({
                name: `r${index}`,
                value,
            }));
            const result = must(
                toolResultPresentation({
                    ok: true,
                    data,
                    meta: { renderAs: "pie" },
                }),
            );
            expect(result.pieRenderable).toBe(sectors.length > 0);
            expect(result.pieRows).toEqual(
                sectors.map(({ name, value, percent, startAngle, endAngle }) => ({
                    name,
                    value,
                    percent,
                    labelPercent: percent * 100,
                    startAngle,
                    endAngle,
                })),
            );
        },
    );
    it("uses JS label coercion and zero for explicit non-number pie values", () => {
        const result = must(
            toolResultPresentation({
                ok: true,
                data: [
                    { label: { x: 1 }, value: 2 },
                    { label: ["a", "b"], value: "3" },
                    { label: null, value: 1 },
                ],
                meta: { renderAs: "pie", xKey: "label", yKeys: ["value"] },
            }),
        );
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
