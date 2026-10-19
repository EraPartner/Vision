// Scenario verification matrix, part 5: the invariant scenarios' metadata. The properties
// themselves run in scenarioMatrix.invariants.test.ts; the docs-sync test reads this list.

import type { ScenarioMeta } from "./scenarioMatrix.ts";

export const INVARIANT_SCENARIOS = {
    "IN-01": {
        id: "IN-01",
        description: "without dependants, joint PIT never exceeds the same couple's separate PIT (property, 300 runs)",
        rows: ["mq-not-higher", "hh-balance-transfer", "hh-per-spouse"],
        articles: "WIB 92 arts 87-88, 126, 134",
        status: "verified",
    },
    "IN-02": {
        id: "IN-02",
        description: "per-partner PIT, taxable income, CSSS and contributions sum to the household totals (property)",
        rows: ["hh-per-spouse", "decumul"],
        articles: "WIB 92 arts 126 §1 al. 2, 130",
        status: "verified",
    },
    "IN-03": {
        id: "IN-03",
        description: "exemption balances and quotient transfers are conserved between partners (property)",
        rows: ["hh-balance-transfer", "mq-art88-topup"],
        articles: "WIB 92 arts 87-88, 134",
        status: "verified",
    },
    "IN-04": {
        id: "IN-04",
        description: "one partner with one activity equals computeBelgianPIT (golden parity harness, nine profiles)",
        rows: ["hh-per-spouse"],
        articles: "—",
        status: "verified",
    },
} as const satisfies Record<string, ScenarioMeta>;
