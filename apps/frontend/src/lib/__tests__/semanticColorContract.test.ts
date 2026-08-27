// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sourceFiles(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            return entry.name === "__tests__" ? [] : sourceFiles(path);
        }
        return /\.(?:ts|tsx|css)$/.test(entry.name) ? [path] : [];
    });
}

describe("semantic color contract", () => {
    it("uses one Tailwind identity for gain/loss text", () => {
        const violations = sourceFiles(join(process.cwd(), "src")).filter((file) => {
            const source = readFileSync(file, "utf8");
            return /\bamount-(?:gain|loss)\b/.test(source);
        });
        expect(violations).toEqual([]);
    });

    it("uses the canonical chart palette in custom charts", () => {
        for (const file of [
            "src/features/statistics/CustomChart.tsx",
            "src/features/statistics/CustomChartBuilderModal.tsx",
        ]) {
            const source = readFileSync(join(process.cwd(), file), "utf8");
            expect(source, file).toContain("getChartColor");
            expect(source, file).not.toContain("Array.from({ length: 16 }");
        }
    });

    it("routes full-card trend washes through TrendHue", () => {
        const netSummary = readFileSync(
            join(process.cwd(), "src/features/dashboard/NetSummaryCard.tsx"),
            "utf8",
        );
        expect(netSummary).toContain('<TrendHue tone={isPositive ? "gain" : "loss"} />');

        const violations = sourceFiles(join(process.cwd(), "src"))
            .filter((file) => !file.endsWith("TrendHue.tsx"))
            .filter((file) => {
                const source = readFileSync(file, "utf8");
                return /from-(?:gain|loss)\/10/.test(source);
            });
        expect(violations).toEqual([]);
    });
});
