// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("self-hosted font assets", () => {
    it("loads every required face from WOFF2-only CSS", () => {
        const entry = readFileSync(join(process.cwd(), "src/main.tsx"), "utf8");
        const fonts = readFileSync(
            join(process.cwd(), "src/styles/fonts.css"),
            "utf8",
        );
        expect(entry).toContain('import "./styles/fonts.css"');
        expect(fonts).not.toContain('.woff")');
        for (const weight of [400, 500, 600, 700]) {
            expect(fonts).toContain(`inter-latin-${weight}-normal.woff2`);
        }
        expect(fonts).toContain("inter-latin-400-italic.woff2");
        for (const weight of [400, 600, 700])
            expect(fonts).toContain(`fraunces-latin-${weight}-normal.woff2`);
    });

    it("keeps Recharts behind a nested AI tool-chart boundary", () => {
        const card = readFileSync(
            join(process.cwd(), "src/features/ai-chat/ToolResultCard.tsx"),
            "utf8",
        );
        const chart = readFileSync(
            join(process.cwd(), "src/features/ai-chat/ToolResultChart.tsx"),
            "utf8",
        );

        expect(card).toContain('lazy(() => import("./ToolResultChart"))');
        expect(card).not.toContain('from "recharts"');
        expect(chart).toContain('from "recharts"');
    });
});
