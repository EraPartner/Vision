import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/index.css"), "utf8");

describe("backdrop-filter declaration order", () => {
    it("declares the standard property after the -webkit- one", () => {
        // The minifier keeps only the last of the pair, and Chromium reads
        // only the standard property (ADR-259).
        expect(css).not.toMatch(
            /(?<!-webkit-)backdrop-filter:[^;{}]*;\s*-webkit-backdrop-filter:/,
        );
    });
});
