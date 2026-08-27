// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const files = [
    "src/components/devtools/RequestList.tsx",
    "src/pages/admin/EndpointLivenessPage.tsx",
    "src/pages/admin/TableDataEditorPage.tsx",
];

describe("admin color semantics", () => {
    it("uses design tokens instead of raw Tailwind palette colors", () => {
        for (const file of files) {
            const source = readFileSync(join(process.cwd(), file), "utf8");
            expect(source, file).not.toMatch(
                /(?:bg|text|border|from|to)-(?:emerald|green|red|blue|sky|orange|amber)-\d+/,
            );
        }
    });
});
