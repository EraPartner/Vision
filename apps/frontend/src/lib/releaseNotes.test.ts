import { describe, expect, test } from "vitest";

import { releaseNotesSummary } from "./releaseNotes";

describe("releaseNotesSummary", () => {
    test("reduces a generated GitHub release body to plain text", () => {
        const body = [
            "<!-- Release notes generated using configuration in .github/release.yml -->",
            "## What's Changed",
            "* fix(frontend): keep **chart** range by @EraPartner in https://github.com/EraPartner/Vision/pull/390",
            "* chore(deps): bump `electron` by @dependabot[bot] in https://github.com/EraPartner/Vision/pull/47",
            "",
            "**Full Changelog**: https://github.com/EraPartner/Vision/compare/v2.0.0...v2.0.1",
        ].join("\n");

        expect(releaseNotesSummary(body)).toBe(
            "fix(frontend): keep chart range by @EraPartner · chore(deps): bump electron by @dependabot[bot]",
        );
    });

    test("keeps link text and plain prose", () => {
        expect(
            releaseNotesSummary(
                "> Faster _imports_ and [new charts](https://example.com/x).\r\n1. Backup fix",
            ),
        ).toBe("Faster imports and new charts. · Backup fix");
    });

    test("returns an empty string when only headings or labels remain", () => {
        expect(
            releaseNotesSummary("## Notes\n\n**Full Changelog**: https://x.y"),
        ).toBe("");
    });
});
