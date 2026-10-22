import { describe, expect, it } from "vitest";
import { sankeyLayout, sankeyLinkPath } from "../sankeyLayout";

// Expected values are d3-sankey 0.12.3's output for the same graph, recorded
// before the package was removed (ADR-245).
const nodes = [
    { id: "salary" },
    { id: "__income__" },
    { id: "__spending__" },
    { id: "__savings__" },
    { id: "rent" },
    { id: "food" },
];
const links = [
    { source: "salary", target: "__income__", value: 3000 },
    { source: "__income__", target: "__spending__", value: 2200 },
    { source: "__income__", target: "__savings__", value: 800 },
    { source: "__spending__", target: "rent", value: 1500 },
    { source: "__spending__", target: "food", value: 700 },
];
const options = {
    nodeWidth: 16,
    nodePadding: 18,
    extent: [
        [0, 0],
        [600, 300],
    ] as [[number, number], [number, number]],
};

describe("sankeyLayout", () => {
    it("matches d3-sankey's node positions and link paths", () => {
        const graph = sankeyLayout({ nodes, links }, options);
        expect(graph.nodes.map((n) => [n.id, n.x0, n.x1, n.y0, n.y1, n.value])).toEqual([
            ["salary", 0, 16, 11.469889948382939, 275.46988994838296, 3000],
            ["__income__", 194.66666666666666, 210.66666666666666, 11.473468674159562, 275.4734686741595, 3000],
            ["__spending__", 389.3333333333333, 405.3333333333333, 90.89863826126015, 284.4986382612603, 2200],
            ["__savings__", 584, 600, 0, 70.39999999999999, 800],
            ["rent", 584, 600, 88.39999999999999, 220.39999999999998, 1500],
            ["food", 584, 600, 238.39999999999998, 300, 700],
        ]);
        expect(graph.links.map((l) => [sankeyLinkPath(l), l.width])).toEqual([
            ["M16,143.46988994838293C105.33333333333333,143.46988994838293,105.33333333333333,143.47346867415956,194.66666666666666,143.47346867415956", 264],
            ["M210.66666666666666,178.67346867415955C300,178.67346867415955,300,187.69863826126016,389.3333333333333,187.69863826126016", 193.6],
            ["M210.66666666666666,46.67346867415956C397.3333333333333,46.67346867415956,397.3333333333333,35.199999999999996,584,35.199999999999996", 70.39999999999999],
            ["M405.3333333333333,156.89863826126015C494.66666666666663,156.89863826126015,494.66666666666663,154.39999999999998,584,154.39999999999998", 132],
            ["M405.3333333333333,253.69863826126016C494.66666666666663,253.69863826126016,494.66666666666663,269.2,584,269.2", 61.599999999999994],
        ]);
    });

    it("does not mutate its input and rejects bad graphs like d3-sankey", () => {
        const input = { nodes: nodes.map((n) => ({ ...n })), links: links.map((l) => ({ ...l })) };
        sankeyLayout(input, options);
        expect(input).toEqual({ nodes, links });
        expect(() =>
            sankeyLayout({ nodes, links: [{ source: "salary", target: "nope", value: 1 }] }, options),
        ).toThrow("missing: nope");
        expect(() =>
            sankeyLayout(
                {
                    nodes: [{ id: "a" }, { id: "b" }],
                    links: [
                        { source: "a", target: "b", value: 1 },
                        { source: "b", target: "a", value: 1 },
                    ],
                },
                options,
            ),
        ).toThrow("circular link");
    });
});
