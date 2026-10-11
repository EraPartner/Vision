// Scenario verification matrix: docs sync. The scenario matrix page
// (docs/reference/belgian-tax-scenario-matrix.md) and the scenario lists must agree both ways:
// every scenario row on the page has a scenario with the same status and matrix rows, every
// scenario is on the page, the "Needs source" table lists exactly the needs_source scenarios and
// the "Row keys" table maps every row key to exactly the scenarios that cite it.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ScenarioMeta } from "./scenarioMatrix";
import { ASSESSMENT_SCENARIOS } from "./scenarioMatrix.assessment";
import { INVARIANT_SCENARIOS } from "./scenarioMatrix.invariants";
import { JOINT_SCENARIOS } from "./scenarioMatrix.joint";
import { REGION_SCENARIOS } from "./scenarioMatrix.regions";
import { SINGLE_SCENARIOS } from "./scenarioMatrix.single";

const PAGE = "docs/reference/belgian-tax-scenario-matrix.md";

/** Walk up from this file to the repository root (the directory that holds the page). */
function findPage(): string {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (;;) {
        const candidate = join(dir, PAGE);
        if (existsSync(candidate)) return candidate;
        const parent = dirname(dir);
        if (parent === dir) throw new Error(`${PAGE} not found above ${import.meta.url}`);
        dir = parent;
    }
}

const ALL: readonly ScenarioMeta[] = [
    ...SINGLE_SCENARIOS,
    ...JOINT_SCENARIOS,
    ...ASSESSMENT_SCENARIOS,
    ...REGION_SCENARIOS,
    ...Object.values(INVARIANT_SCENARIOS),
];

/** Body of the `## heading` section, up to the next level-2 heading. */
function section(page: string, heading: string): string[] {
    const lines = page.split("\n");
    const start = lines.indexOf(`## ${heading}`);
    expect(start, `section "${heading}" on the page`).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > start && line.startsWith("## "));
    return lines.slice(start + 1, end === -1 ? undefined : end);
}

/** Cells of the table body rows in `lines` (header and separator rows skipped). */
function tableRows(lines: readonly string[]): string[][] {
    const rows: string[][] = [];
    for (const line of lines) {
        if (!line.startsWith("| ")) continue;
        // Split on pipes that are not escaped (wikilink aliases inside a table use `\|`).
        const cells = line
            .slice(1, -1)
            .split(/(?<!\\)\|/)
            .map((c) => c.trim());
        if (cells[0] === "Id" || cells[0] === "Key" || /^-+$/.test(cells[0] ?? "")) continue;
        rows.push(cells);
    }
    return rows;
}

const keysIn = (cell: string): string[] => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
const idsIn = (cell: string): string[] =>
    cell === "—" ? [] : cell.split(",").map((id) => id.trim()).filter(Boolean);
const sorted = (values: Iterable<string>): string[] => [...values].sort();

describe("scenario matrix: docs sync", () => {
    const page = readFileSync(findPage(), "utf8");

    test("scenario ids are unique", () => {
        const ids = ALL.map((s) => s.id);
        expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    });

    test("every page row has a scenario and every scenario is on the page with its status and rows", () => {
        const pageRows = tableRows(section(page, "Scenarios"));
        const onPage = new Map(pageRows.map((cells) => [cells[0] as string, cells]));
        expect(onPage.size, "duplicate ids on the page").toBe(pageRows.length);
        expect(sorted(onPage.keys())).toEqual(sorted(ALL.map((s) => s.id)));
        for (const s of ALL) {
            const cells = onPage.get(s.id) as string[];
            expect(cells.at(-1), `${s.id} status on the page`).toBe(s.status);
            expect(sorted(keysIn(cells.at(-2) ?? "")), `${s.id} matrix rows on the page`).toEqual(
                sorted(s.rows),
            );
        }
    });

    test("the Needs source table lists exactly the needs_source scenarios", () => {
        const listed = tableRows(section(page, "Needs source")).map((cells) => cells[0] as string);
        expect(sorted(listed)).toEqual(
            sorted(ALL.filter((s) => s.status === "needs_source").map((s) => s.id)),
        );
    });

    test("the Row keys table maps every row key to the scenarios that cite it", () => {
        const expected = new Map<string, Set<string>>();
        for (const s of ALL) {
            for (const key of s.rows) {
                if (!expected.has(key)) expected.set(key, new Set());
                expected.get(key)?.add(s.id);
            }
        }
        const pageKeys = new Map<string, string[]>();
        for (const cells of tableRows(section(page, "Row keys"))) {
            const [key] = keysIn(cells[0] ?? "");
            expect(key, `row key in "${cells[0]}"`).toBeDefined();
            pageKeys.set(key as string, sorted(idsIn(cells.at(-1) ?? "")));
        }
        for (const key of expected.keys()) {
            expect(pageKeys.has(key), `row key \`${key}\` in the Row keys table`).toBe(true);
        }
        for (const [key, ids] of pageKeys) {
            expect(ids, `scenarios of \`${key}\``).toEqual(sorted(expected.get(key) ?? []));
        }
    });
});
