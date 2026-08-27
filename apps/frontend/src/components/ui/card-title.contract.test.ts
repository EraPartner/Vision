// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceTree(directory: string): string {
    return readdirSync(directory, { withFileTypes: true })
        .map((entry) => {
            const path = join(directory, entry.name);
            if (entry.isDirectory())
                return entry.name === "__tests__" ? "" : sourceTree(path);
            if (entry.name.includes(".test.") || entry.name === "card.tsx")
                return "";
            return /\.tsx$/.test(entry.name) ? readFileSync(path, "utf8") : "";
        })
        .join("\n");
}

describe("CardTitle typography", () => {
    it("routes compact titles through named variants instead of size overrides", () => {
        const source = sourceTree(join(process.cwd(), "src"));
        const tags = [...source.matchAll(/<CardTitle\b[\s\S]*?>/g)].map(
            (match) => match[0],
        );
        expect(tags.length).toBeGreaterThan(50);
        expect(
            tags.filter((tag) => /\btext-(?:2xs|xs|sm|base|lg|xl)\b/.test(tag)),
        ).toEqual([]);
        const statCard = readFileSync(
            join(process.cwd(), "src/components/shared/StatCard.tsx"),
            "utf8",
        );
        expect(statCard).toContain('<CardTitle variant="label">');
        expect(statCard).not.toContain("statTitleVariants");
    });

    it("keeps the smallest display variant at text-lg and labels on the body eyebrow role", () => {
        const primitive = readFileSync(
            join(process.cwd(), "src/components/ui/card.tsx"),
            "utf8",
        );
        expect(primitive).toContain('sm: "font-display text-lg');
        expect(primitive).toContain('label: "eyebrow"');
        expect(primitive).not.toMatch(/font-display text-(?:2xs|xs|sm|base)\b/);
    });

    it("defaults page card titles to h2 and supports explicit nested levels", () => {
        const primitive = readFileSync(
            join(process.cwd(), "src/components/ui/card.tsx"),
            "utf8",
        );
        expect(primitive).toContain("level?: 2 | 3 | 4");
        expect(primitive).toContain("level = 2");
        expect(primitive).toContain("const Heading = `h${level}`");
    });
});
