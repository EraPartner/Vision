// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("nested glass hygiene", () => {
    it("keeps AI composer and tool-table chrome opaque inside glass cards", () => {
        for (const file of [
            "src/features/ai-chat/ChatComposer.tsx",
            "src/features/ai-chat/ToolResultCard.tsx",
        ]) {
            const source = read(file);
            expect(source, file).not.toContain("glass-thin");
            expect(source, file).not.toContain("backdrop-blur-sm");
        }
        expect(read("src/features/ai-chat/ChatComposer.tsx")).toContain(
            "border-t border-border/60 bg-card",
        );
        expect(read("src/features/ai-chat/ToolResultCard.tsx")).toContain(
            "sticky top-0 bg-card",
        );
    });

    it("keeps moving chart overlays opaque", () => {
        for (const file of [
            "src/components/charts/ChartTooltip.tsx",
            "src/components/charts/AreaChart.tsx",
            "src/components/charts/LineChart.tsx",
        ]) {
            const source = read(file);
            expect(source, file).not.toContain("glass-thick");
        }
        expect(read("src/components/charts/ChartTooltip.tsx")).toContain(
            "bg-popover",
        );
    });

    it("limits the canvas halo and pauses CSS drift under WebGL", () => {
        const css = read("src/index.css");
        const pageHeader = read("src/components/shared/PageHeader.tsx");
        expect(css).not.toContain(".canvas-text :is(");
        expect(css).toContain(".dark .page-header-title");
        expect(pageHeader).toContain("page-header-title");
        expect(pageHeader).toContain("page-header-subtitle");
        expect(css).toContain(":root.fx-webgl-live .liquid-canvas::before");
        expect(read("src/components/layout/ShaderAurora.tsx")).toContain(
            'classList.add("fx-webgl-live")',
        );
    });

    it("does not leave the stale sidebar bootleg", () => {
        const sidebar = read("src/components/layout/AppSidebar.tsx");
        expect(sidebar).not.toContain("backdrop-blur-sm");
    });

    it("keeps the pivot frozen column opaque without per-cell backdrop filters", () => {
        const pivot = read("src/features/statistics/CategoryPivotTable.tsx");
        const css = read("src/index.css");
        expect(pivot).toContain("table-sticky-col");
        expect(pivot).not.toContain("glass-sticky-col");
        expect(css).toContain(".table-sticky-col");
        expect(css).not.toContain(".glass-sticky-col");
    });
});
