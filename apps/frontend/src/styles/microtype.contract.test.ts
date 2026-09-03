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
            if (entry.name.includes(".test.") || entry.name === "generated.ts")
                return "";
            return /\.(?:ts|tsx)$/.test(entry.name)
                ? readFileSync(path, "utf8")
                : "";
        })
        .join("\n");
}

describe("microtype scale", () => {
    it("uses the named 2xs role instead of arbitrary 10px/11px utilities", () => {
        const source = sourceTree(join(process.cwd(), "src"));
        expect(source).not.toMatch(
            /text-\[(?:(?:10|11)px|0\.(?:625|6875)rem)\]/,
        );
        const config = readFileSync(
            join(process.cwd(), "tailwind.config.ts"),
            "utf8",
        );
        expect(config).toContain(
            "'2xs': ['0.6875rem', { lineHeight: '0.875rem' }]",
        );
    });

    it("routes standalone uppercase labels through the eyebrow role", () => {
        const sourceRoot = join(process.cwd(), "src");
        const source = sourceTree(sourceRoot).replaceAll(
            "[&_[cmdk-group-heading]]:uppercase",
            "",
        );
        expect(source).not.toMatch(/\buppercase\b/);
        const indexCss = readFileSync(join(sourceRoot, "index.css"), "utf8");
        expect(indexCss).toMatch(
            /\.eyebrow\s*\{[\s\S]*letter-spacing: 0\.12em/,
        );
        expect(indexCss).toMatch(
            /\.eyebrow\s*\{[\s\S]*font-family: var\(--font-body\)/,
        );
    });
});
