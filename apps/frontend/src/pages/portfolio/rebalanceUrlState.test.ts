import { describe, expect, it } from "vitest";
import {
    defaultRebalanceDraft,
    parseRebalanceUrl,
    writeRebalanceUrl,
} from "./rebalanceUrlState";

describe("rebalance URL state", () => {
    it("round-trips ordered unfinished rows, unicode names, and an empty enabled cap", () => {
        const params = writeRebalanceUrl(new URLSearchParams("keep=yes"), {
            source: "custom",
            rows: [
                { sleeve: "stocks", pct: "60.5" },
                { sleeve: "", pct: "" },
                { sleeve: "bonds", pct: "39.5" },
            ],
            name: "Pensioen €",
            capEnabled: true,
            cap: "",
        });
        expect(params.get("keep")).toBe("yes");
        expect(params.getAll("target")).toEqual([
            "stocks:60.5",
            ":",
            "bonds:39.5",
        ]);
        expect(params.has("cap")).toBe(true);
        expect(parseRebalanceUrl(params)).toMatchObject({
            source: "custom",
            name: "Pensioen €",
            capEnabled: true,
            cap: "",
        });
        expect(parseRebalanceUrl(params).rows).toEqual([
            { sleeve: "stocks", pct: "60.5" },
            { sleeve: "", pct: "" },
            { sleeve: "bonds", pct: "39.5" },
        ]);
    });

    it("bounds rows and rejects invalid sleeves and sources", () => {
        const params = new URLSearchParams("source=bad&keep=yes");
        params.append("target", "invalid:10");
        for (let i = 0; i < 12; i++) params.append("target", "stocks:1");
        const draft = parseRebalanceUrl(params);
        expect(draft.source).toBe(defaultRebalanceDraft().source);
        expect(draft.rows).toHaveLength(7);
    });

    it("model selection clears only rebalance-owned keys", () => {
        const previous = new URLSearchParams(
            "source=custom&target=stocks%3A100&name=x&cap=2&keep=yes",
        );
        const next = writeRebalanceUrl(previous, defaultRebalanceDraft());
        expect(next.toString()).toBe("keep=yes");
    });
});
