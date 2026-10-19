// Scenario verification matrix, part 1: one taxpayer (scenarios in scenarioMatrix.single.ts).

import { describe, test } from "vitest";
import { computeBelgianPIT } from "../../src/belgianTax/pit.ts";
import { makeTaxProfile } from "./testProfile.ts";
import { eur, runScenarios } from "./scenarioMatrix.ts";
import { SINGLE_SCENARIOS } from "./scenarioMatrix.single.ts";

runScenarios("scenario matrix: one taxpayer", SINGLE_SCENARIOS);

describe("scenario matrix: one taxpayer, single-profile engine (computeBelgianPIT)", () => {
    // The v1 engine has no social-contribution input and no helping-spouse kind; the scenarios
    // without either are recomputed through it with the same hand-derived totals.
    test.each([
        ["SC-01", makeTaxProfile({ employmentType: "employee", grossAnnualIncome: 50_000 }), 10_994.5175],
        ["SC-02", makeTaxProfile({ employmentType: "civil_servant", grossAnnualIncome: 50_000 }), 11_480.8325],
        ["SC-03", makeTaxProfile({ employmentType: "director", grossAnnualIncome: 60_000 }), 21_391.975],
        [
            "SC-12",
            makeTaxProfile({ grossAnnualIncome: 50_000, dependentChildren: 2, isIsolatedParent: true }),
            8_568.2925,
        ],
        [
            "SC-13",
            makeTaxProfile({ grossAnnualIncome: 50_000, taxYear: 2026, dependentChildren: 1, dependentChildrenUnder3: 1 }),
            9_743.1525,
        ],
        [
            "SC-15",
            makeTaxProfile({
                grossAnnualIncome: 50_000,
                taxYear: 2024,
                dependentChildren: 1,
                dependentChildrenDisabled: 1,
                dependentOtherPersons: 1,
                dependentOtherPersonsDisabled: 1,
            }),
            8_128.5225,
        ],
    ] as const)("%s", (_id, profile, expected) => {
        eur(computeBelgianPIT(profile).totalPIT, expected);
    });
});
