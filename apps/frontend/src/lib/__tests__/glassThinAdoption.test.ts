// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function read(relativePath: string): string {
    return readFileSync(join(process.cwd(), relativePath), "utf8");
}

describe("glass-thin adoption", () => {
    it("owns the AI composer and tool-table chrome", () => {
        for (const file of [
            "src/features/ai-chat/ChatComposer.tsx",
            "src/features/ai-chat/ToolResultCard.tsx",
        ]) {
            const source = read(file);
            expect(source, file).toContain("glass-thin");
            expect(source, file).not.toContain("backdrop-blur-sm");
        }
        expect(read("src/features/ai-chat/ChatComposer.tsx")).toContain(
            "glass-thin !border-x-0 !border-b-0",
        );
    });

    it("does not leave the stale sidebar bootleg", () => {
        const sidebar = read("src/components/layout/AppSidebar.tsx");
        expect(sidebar).not.toContain("backdrop-blur-sm");
    });
});
