// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("self-hosted font assets", () => {
    it("loads every Inter face used by the typography roles", () => {
        const entry = readFileSync(join(process.cwd(), "src/main.tsx"), "utf8");

        for (const asset of [
            "latin-400.css",
            "latin-400-italic.css",
            "latin-500.css",
            "latin-600.css",
            "latin-700.css",
        ]) {
            expect(entry).toContain(`@fontsource/inter/${asset}`);
        }
    });
});
