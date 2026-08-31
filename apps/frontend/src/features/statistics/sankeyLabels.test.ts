import { describe, expect, it, vi } from "vitest";
import { localizeSankeyLabel, sankeyColorKey } from "./sankeyLabels";

describe("localizeSankeyLabel", () => {
    const translate = vi.fn((key: string) => `translated:${key}`);

    it.each([
        ["__income__", "statsPage.sankey.income"],
        ["__spending__", "statsPage.sankey.spending"],
        ["__funding_gap__", "statsPage.sankey.fundingGap"],
        ["__uncategorised__", "statsPage.sankey.uncategorised"],
        ["__other__", "statsPage.sankey.other"],
        ["__savings__", "statsPage.sankey.savings"],
    ])("localizes reserved node %s", (id, key) => {
        expect(localizeSankeyLabel(id, id, translate)).toBe(
            `translated:${key}`,
        );
    });

    it("leaves user category labels untouched", () => {
        expect(localizeSankeyLabel("cat:7", "Uncategorised", translate)).toBe(
            "Uncategorised",
        );
    });
});

describe("sankeyColorKey", () => {
    it("uses the category label to match sibling charts", () => {
        expect(sankeyColorKey("cat:17", "Food: Groceries")).toBe(
            "Food: Groceries",
        );
    });

    it("uses stable protocol identity for localized reserved nodes", () => {
        expect(sankeyColorKey("__income__", "Inkomsten")).toBe("__income__");
    });
});
