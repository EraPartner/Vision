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

import { describe, expect, test } from "vitest";
import { computeHouseholdTax } from "../../src/belgianTax/household.ts";
import type { BelgianTaxHouseholdV2, HouseholdTaxResult } from "../../src/belgianTax/householdTypes.ts";

export type ScenarioStatus = "verified" | "needs_source";

/** What the scenario matrix page lists for a scenario. */
export interface ScenarioMeta {
    id: string;
    description: string;
    /** Rule-matrix row keys (see the scenario matrix page, "Row keys"). */
    rows: readonly string[];
    /** Articles the expected figures rest on. */
    articles: string;
    status: ScenarioStatus;
    /** For `needs_source`: the rule or amount the matrix does not carry. */
    missing?: string;
}

export interface Scenario extends ScenarioMeta {
    household: BelgianTaxHouseholdV2;
    verify: (result: HouseholdTaxResult) => void;
}

/** Money comparison: hand-derived figures carry at most four decimals. */
export function eur(actual: number | undefined, expected: number): void {
    expect(actual).toBeDefined();
    expect(actual as number).toBeCloseTo(expected, 6);
}

export function scenarioTitle(s: ScenarioMeta): string {
    return `${s.id} [${s.status}] ${s.description}`;
}

/**
 * Run each scenario through `computeHouseholdTax`. That every scenario is listed on the scenario
 * matrix page with its status and rows is checked once, in scenarioMatrix.docs.test.ts.
 */
export function runScenarios(title: string, scenarios: readonly Scenario[]): void {
    describe(title, () => {
        for (const s of scenarios) {
            test(scenarioTitle(s), () => {
                if (s.status === "needs_source") expect(s.missing).toBeTruthy();
                s.verify(computeHouseholdTax(s.household));
            });
        }
    });
}
