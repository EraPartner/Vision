// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CardContent } from "./card";

function sourceTree(directory: string): string {
    return readdirSync(directory, { withFileTypes: true })
        .map((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory())
                return entry.name === "__tests__" ? "" : sourceTree(path);
            if (entry.name.includes(".test.") || entry.name === "card.tsx")
                return "";
            return entry.name.endsWith(".tsx")
                ? readFileSync(path, "utf8")
                : "";
        })
        .join("\n");
}

describe("CardContent spacing", () => {
    it.each([
        ["default", "p-6 pt-0"],
        ["headerless", "p-6"],
        ["flush", "p-0"],
        ["compact", "p-4"],
        ["row", "px-6 py-4"],
        ["state", "px-6 py-8"],
    ] as const)("renders the %s spacing role", (variant, classes) => {
        const markup = renderToStaticMarkup(
            <CardContent variant={variant}>Content</CardContent>,
        );
        for (const className of classes.split(" ")) {
            expect(markup).toContain(className);
        }
    });

    it("routes repeated padding shapes through named variants", () => {
        const source = sourceTree(join(process.cwd(), "src"));
        const tags = [...source.matchAll(/<CardContent\b[\s\S]*?>/g)].map(
            (match) => match[0],
        );
        const repeatedOverrides = /\b(?:p-[046]|pt-[06]|py-[468])\b/;

        expect(
            tags.filter(
                (tag) =>
                    repeatedOverrides.test(tag) ||
                    (/\bpt-4\b/.test(tag) && /\bpb-4\b/.test(tag)),
            ),
        ).toEqual([]);
    });
});
