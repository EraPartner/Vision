// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(file: string): string {
    return readFileSync(join(process.cwd(), "src/features/settings", file), "utf8");
}

describe("AI settings anatomy", () => {
    it("uses the shared group and row primitives without nested section headings", () => {
        for (const file of ["AIChatSettingsSection.tsx", "ResearchKeysSection.tsx"]) {
            const contents = source(file);
            expect(contents).toContain("SettingsGroup");
            expect(contents).toContain("SettingRow");
            expect(contents).not.toMatch(/<h[2-4]\b/);
            expect(contents).not.toMatch(/rounded-lg border/);
        }

        const appearance = source("sections/AppearanceSection.tsx");
        expect(appearance).toMatch(/SettingsGroup>[\s\S]*SettingRow[\s\S]*settings\.appearance\.variant/);
        expect(appearance).not.toMatch(/<div className="space-y-3">[\s\S]*settings\.appearance\.variant/);
    });
});
