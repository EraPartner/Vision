/**
 * Scenario verification matrix: shared types and runner.
 *
 * Every scenario is a table entry with an id, the rule-matrix rows it exercises (row keys listed
 * in docs/reference/belgian-tax-scenario-matrix.md, "Row keys"), the WIB 92 articles, a household
 * input and an expectation. The expected figures are derived by hand from the cited article and
 * the indexed amounts recorded in docs/reference/belgian-tax-rule-matrix.md; the arithmetic is
 * written next to each scenario. They are never copied from the engine's output.
 *
 * Status:
 *  - `verified`: every asserted figure follows from verified matrix rows.
 *  - `needs_source`: the correct result depends on a rule the matrix does not carry; the scenario
 *    asserts only the sourced parts (and the issue the engine raises) and names what is missing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { computeHouseholdTax } from "../household";
import type { BelgianTaxHouseholdV2, HouseholdTaxResult } from "../householdTypes";

export type ScenarioStatus = "verified" | "needs_source";

export interface Scenario {
    id: string;
    description: string;
    /** Rule-matrix row keys (see the scenario matrix page, "Row keys"). */
    rows: readonly string[];
    /** Articles the expected figures rest on. */
    articles: string;
    status: ScenarioStatus;
    /** For `needs_source`: the rule or amount the matrix does not carry. */
    missing?: string;
    household: BelgianTaxHouseholdV2;
    verify: (result: HouseholdTaxResult) => void;
}

/** Money comparison: hand-derived figures carry at most four decimals. */
export function eur(actual: number | undefined, expected: number): void {
    expect(actual).toBeDefined();
    expect(actual as number).toBeCloseTo(expected, 6);
}

/** The page that lists every scenario (vitest runs from apps/frontend). */
const SCENARIO_PAGE = join(process.cwd(), "../../docs/reference/belgian-tax-scenario-matrix.md");

export function runScenarios(title: string, scenarios: readonly Scenario[]): void {
    describe(title, () => {
        const page = readFileSync(SCENARIO_PAGE, "utf8");
        for (const s of scenarios) {
            test(`${s.id} [${s.status}] ${s.description}`, () => {
                const row = page.split("\n").find((line) => line.startsWith(`| ${s.id} |`));
                expect(row, "scenario listed on the scenario matrix page").toBeDefined();
                expect(row?.endsWith(`| ${s.status} |`), "status on the page").toBe(true);
                if (s.status === "needs_source") expect(s.missing).toBeTruthy();
                s.verify(computeHouseholdTax(s.household));
            });
        }
    });
}
