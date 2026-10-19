// Scenario verification matrix, part 3: assessment mode per WIB 92 art. 126 through the full
// household computation. Partner A earns 50,000 gross as an employee, B 20,000 (IY 2025 figures
// of part 1: A net 37,535 → PIT 10,994.5175, CSSS single 343.15719; B net 12,170.20 → tax
// 3,042.55 − 2,727.50 = 315.05 × 1.07 = 337.1035, CSSS 0 below 18,592.02).

import { expect } from "vitest";
import { activity, event, household, married, partner } from "./testHousehold.ts";
import { eur, type Scenario } from "./scenarioMatrix.ts";
import type { BelgianTaxHouseholdV2, RelationshipEvent } from "../../src/belgianTax/householdTypes.ts";

const couple = (
    events: RelationshipEvent[],
    extra: Partial<BelgianTaxHouseholdV2> = {},
): BelgianTaxHouseholdV2 =>
    household([partner("A", [activity("employee", 50_000)]), partner("B", [activity("employee", 20_000)])], {
        relationship: { events },
        ...extra,
    });

/** Separate assessment of the two partners above, IY 2025. */
const SEPARATE_2025_PIT = 10_994.5175 + 337.1035;

export const ASSESSMENT_SCENARIOS: readonly Scenario[] = [
    {
        id: "AS-01",
        description: "year of marriage → separate; each partner on the single CSSS scale",
        rows: ["hh-union-year", "decumul", "csss-single", "hh-csss"],
        articles: "WIB 92 art. 126 §2 al. 1, 1°; law 30-03-1994 art. 108 §1 al. 2",
        status: "verified",
        household: couple([event("marriage", "2025-06-01")]),
        verify: (r) => {
            // 10,994.5175 + 337.1035 = 11,331.621; CSSS 343.15719 + 0
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "union_year" });
            expect(r.quotient.applied).toBe(false);
            eur(r.totals.totalPIT, SEPARATE_2025_PIT);
            expect(r.csss.scale).toBe("single");
            eur(r.csss.total, 343.15719);
        },
    },
    {
        id: "AS-02",
        description: "year after the marriage → joint",
        rows: ["hh-union-year", "art126-joint"],
        articles: "WIB 92 art. 126 §1",
        status: "verified",
        household: couple([event("marriage", "2024-06-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "joint", reason: "union_in_force" });
        },
    },
    {
        id: "AS-03",
        description: "year of the legal-cohabitation declaration → separate",
        rows: ["hh-union-year"],
        articles: "WIB 92 art. 126 §2 al. 1, 1°",
        status: "verified",
        household: couple([event("legal_cohabitation", "2025-03-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "union_year" });
            eur(r.totals.totalPIT, SEPARATE_2025_PIT);
        },
    },
    {
        id: "AS-04",
        description: "legal cohabitants (2023) who marry in 2025 stay joint in 2025",
        rows: ["hh-union-year"],
        articles: "WIB 92 art. 126 §2 al. 2",
        status: "verified",
        household: couple([event("legal_cohabitation", "2023-01-10"), event("marriage", "2025-06-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "joint", reason: "union_year_after_legal_cohabitation" });
        },
    },
    {
        id: "AS-05",
        description: "declaration and marriage in the same year → separate",
        rows: ["hh-union-year"],
        articles: "WIB 92 art. 126 §2 al. 2 (\"tenzij … tijdens hetzelfde jaar\")",
        status: "verified",
        household: couple([event("legal_cohabitation", "2025-01-10"), event("marriage", "2025-06-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "union_year" });
        },
    },
    {
        id: "AS-06",
        description: "year the legal cohabitation ends → separate",
        rows: ["hh-dissolution"],
        articles: "WIB 92 art. 126 §2 al. 1, 3°",
        status: "verified",
        household: couple([event("legal_cohabitation", "2020-02-01"), event("legal_cohabitation_ended", "2025-05-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "dissolution_year" });
            eur(r.totals.totalPIT, SEPARATE_2025_PIT);
        },
    },
    {
        id: "AS-07",
        description: "year of factual separation → still joint",
        rows: ["hh-factual-separation"],
        articles: "WIB 92 art. 126 §2 al. 1, 2°",
        status: "verified",
        household: couple([event("marriage", "2015-05-02"), event("factual_separation", "2025-04-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "joint", reason: "factual_separation_year" });
            expect(r.csss.scale).toBe("joint");
        },
    },
    {
        id: "AS-08",
        description: "year after the factual separation → separate",
        rows: ["hh-factual-separation"],
        articles: "WIB 92 art. 126 §2 al. 1, 2° (\"vanaf het jaar na dat waarin\")",
        status: "verified",
        household: couple([event("marriage", "2015-05-02"), event("factual_separation", "2024-04-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "factually_separated" });
            eur(r.totals.totalPIT, SEPARATE_2025_PIT);
        },
    },
    {
        id: "AS-09",
        description: "year of divorce → separate; the year before stays joint",
        rows: ["hh-dissolution"],
        articles: "WIB 92 art. 126 §2 al. 1, 3°",
        status: "verified",
        household: couple([event("marriage", "2015-05-02"), event("divorce", "2025-09-01")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "dissolution_year" });
            eur(r.totals.totalPIT, SEPARATE_2025_PIT);
        },
    },
    {
        id: "AS-10",
        description: "year of death without election → separate (electable)",
        rows: ["hh-death"],
        articles: "WIB 92 art. 126 §2 al. 1, 3° and §3",
        status: "verified",
        household: {
            ...married([activity("net_professional_amount", 40_000)], [activity("net_professional_amount", 0)]),
            relationship: { events: [event("marriage", "2015-05-02"), event("death", "2025-08-01", "B")] },
        },
        verify: (r) => {
            // A alone on 40,000: 14,112 − 2,727.50 = 11,384.50 × 1.07 = 12,181.415; B 0
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "death_year", electable: true });
            eur(r.totals.totalPIT, 12_181.415);
        },
    },
    {
        id: "AS-11",
        description: "year of death with the survivor's election → joint (quotient of JQ-05)",
        rows: ["hh-death", "mq-cap"],
        articles: "WIB 92 art. 126 §3, art. 87",
        status: "verified",
        household: {
            ...married([activity("net_professional_amount", 40_000)], [activity("net_professional_amount", 0)]),
            relationship: {
                events: [event("marriage", "2015-05-02"), event("death", "2025-08-01", "B")],
                deathYearElection: "joint",
            },
        },
        verify: (r) => {
            // Same as JQ-05: 6,297 × 1.07 = 6,737.79
            expect(r.assessment).toMatchObject({ mode: "joint", reason: "death_year_joint_election" });
            eur(r.totals.totalPIT, 6_737.79);
        },
    },
    {
        id: "AS-12",
        description: "year after the death → only the survivor is assessed",
        rows: ["hh-death"],
        articles: "WIB 92 art. 126 §2 al. 1, 3°",
        status: "verified",
        household: couple([event("marriage", "2015-05-02"), event("death", "2024-03-01", "B")]),
        verify: (r) => {
            expect(r.assessment).toMatchObject({ mode: "single", reason: "surviving_partner", partnerIds: ["A"] });
            expect(r.partners.map((p) => p.partnerId)).toEqual(["A"]);
            eur(r.totals.totalPIT, 10_994.5175);
        },
    },
    {
        id: "AS-13",
        description: "factual cohabitants: separate; dependants with the claimant partner B",
        rows: ["hh-no-union", "hh-supplements-allocation", "children-supplements"],
        articles: "WIB 92 arts 126 §1, 132 al. 1, 1°",
        status: "needs_source",
        missing:
            "B's child supplement is not used in full (exemption 12,890 against taxable income 12,170.20), so the art. 134 §3 refundable child tax credit applies; its formula is not in the matrix (refundable_child_credit_not_modelled). The asserted figures hold before that credit",
        household: couple([event("factual_cohabitation_start", "2019-01-01")], {
            dependents: { children: 1, otherPersons: 0, claimantPartnerId: "B" },
        }),
        verify: (r) => {
            // Figures before the art. 134 §3 refundable credit, which is not modelled.
            // B: exemption 10,910 + 1,980 = 12,890 → applied min(12,890, 12,170.20): 2,865 +
            //   710.20 × 30% = 3,078.06 ≥ tax 3,042.55 → 0; A as SC-01
            expect(r.issues).toContainEqual({
                code: "refundable_child_credit_not_modelled",
                severity: "needs_source",
            });
            expect(r.assessment).toMatchObject({ mode: "separate", reason: "no_legal_union" });
            eur(r.partners[1]?.exemption.dependentSupplements, 1_980);
            eur(r.partners[1]?.totalPIT, 0);
            eur(r.totals.totalPIT, 10_994.5175);
        },
    },
    {
        id: "AS-14",
        description: "isolated-parent supplement under a separate assessment with a partner",
        rows: ["hh-isolated-parent-partner"],
        articles: "WIB 92 art. 133 al. 1, 1°; law of 15 July 2026 art. 9",
        status: "needs_source",
        missing: "Whether a separately assessed taxpayer living with a partner is \"alone\" for art. 133 (L2 art. 9 household test)",
        household: {
            ...couple([event("factual_cohabitation_start", "2019-01-01")], {
                dependents: { children: 1, otherPersons: 0 },
            }),
            partners: [
                partner("A", [activity("employee", 50_000)], { isIsolatedParent: true }),
                partner("B", [activity("employee", 20_000)]),
            ],
        },
        verify: (r) => {
            expect(r.issues).toContainEqual({
                code: "isolated_parent_supplement_not_granted",
                severity: "needs_source",
                partnerId: "A",
            });
        },
    },
];
