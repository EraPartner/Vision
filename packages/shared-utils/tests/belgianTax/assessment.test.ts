import { describe, expect, test } from "vitest";
import { deriveAssessment } from "../../src/belgianTax/assessment.ts";
import type { RelationshipEvent } from "../../src/belgianTax/householdTypes.ts";
import { activity, event, household, partner } from "./testHousehold.ts";

const couple = (events: RelationshipEvent[], extra: { deathYearElection?: "joint" | "separate"; legacyAssumedJoint?: boolean } = {}) =>
    household(
        [partner("A", [activity("employee", 40_000)]), partner("B", [activity("employee", 30_000)])],
        { relationship: { events, ...extra } },
    );

describe("deriveAssessment (WIB 92 art. 126)", () => {
    test("one partner is assessed alone", () => {
        const h = household([partner("A", [activity("employee", 40_000)])]);
        expect(deriveAssessment(h, 2025).decision).toMatchObject({ mode: "single", reason: "one_partner", partnerIds: ["A"] });
    });

    test("two partners without a marriage or legal cohabitation are assessed separately", () => {
        const h = couple([event("factual_cohabitation_start", "2020-01-01")]);
        expect(deriveAssessment(h, 2025).decision).toMatchObject({ mode: "separate", reason: "no_legal_union" });
    });

    test("a migrated married_joint profile without dates stays joint with a warning", () => {
        const outcome = deriveAssessment(couple([], { legacyAssumedJoint: true }), 2025);
        expect(outcome.decision).toMatchObject({ mode: "joint", reason: "legacy_assumed_joint" });
        expect(outcome.issues).toContainEqual({ code: "relationship_dates_missing", severity: "warning" });
    });

    const marriage2025 = [event("marriage", "2025-06-14")];
    const lc2024ThenMarriage = [event("legal_cohabitation", "2024-03-01"), event("marriage", "2025-06-14")];
    const lcAndMarriage2025 = [event("legal_cohabitation", "2025-02-01"), event("marriage", "2025-06-14")];
    const divorce = [event("marriage", "2015-05-02"), event("divorce", "2025-09-01")];
    const lcEnded = [event("legal_cohabitation", "2015-05-02"), event("legal_cohabitation_ended", "2025-09-01")];
    const separation = [event("marriage", "2015-05-02"), event("factual_separation", "2025-04-01")];
    const death = [event("marriage", "2015-05-02"), event("death", "2025-05-01", "B")];

    test.each([
        ["marriage 2025-06-14", marriage2025, 2024, "separate", "no_legal_union"],
        ["marriage 2025-06-14", marriage2025, 2025, "separate", "union_year"],
        ["marriage 2025-06-14", marriage2025, 2026, "joint", "union_in_force"],
        ["legal cohabitation 2024, marriage 2025", lc2024ThenMarriage, 2024, "separate", "union_year"],
        ["legal cohabitation 2024, marriage 2025", lc2024ThenMarriage, 2025, "joint", "union_year_after_legal_cohabitation"],
        ["legal cohabitation and marriage in 2025", lcAndMarriage2025, 2025, "separate", "union_year"],
        ["divorce 2025", divorce, 2024, "joint", "union_in_force"],
        ["divorce 2025", divorce, 2025, "separate", "dissolution_year"],
        ["divorce 2025", divorce, 2026, "separate", "dissolved"],
        ["legal cohabitation ended 2025", lcEnded, 2025, "separate", "dissolution_year"],
        ["factual separation 2025", separation, 2025, "joint", "factual_separation_year"],
        ["factual separation 2025", separation, 2026, "separate", "factually_separated"],
        ["death 2025", death, 2025, "separate", "death_year"],
        ["death 2025", death, 2026, "single", "surviving_partner"],
    ] as const)("%s → IY %i is %s (%s)", (_label, events, year, mode, reason) => {
        expect(deriveAssessment(couple([...events]), year).decision).toMatchObject({ mode, reason });
    });

    test("year of death: separate by default, joint when the survivor elects it (art. 126 §3)", () => {
        const events = [event("marriage", "2015-05-02"), event("death", "2025-05-01", "B")];
        expect(deriveAssessment(couple(events), 2025).decision.electable).toBe(true);
        expect(deriveAssessment(couple(events, { deathYearElection: "joint" }), 2025).decision).toMatchObject({
            mode: "joint",
            reason: "death_year_joint_election",
        });
    });

    test("after the year of death only the survivor is assessed", () => {
        const events = [event("marriage", "2015-05-02"), event("death", "2025-05-01", "B")];
        const outcome = deriveAssessment(couple(events), 2026);
        expect(outcome.decision.partnerIds).toEqual(["A"]);
        expect(outcome.issues).toContainEqual({ code: "deceased_partner_not_assessed", severity: "info", partnerId: "B" });
    });

    test.each([
        [2024, 13_050, "joint"],
        [2024, 13_051, "separate"],
        [2025, 13_460, "joint"],
        [2025, 13_461, "separate"],
        [2026, 11_550, "joint"],
        [2026, 11_551, "separate"],
    ] as const)("IY %i treaty-exempt income %i → %s (art. 126 §2 al. 1, 4°)", (year, amount, mode) => {
        const h = household(
            [
                partner("A", [activity("employee", 40_000)]),
                partner("B", [], { treatyExemptProfessionalIncome: amount }),
            ],
            { relationship: { events: [event("marriage", "2015-05-02")] } },
        );
        expect(deriveAssessment(h, year).decision.mode).toBe(mode);
    });

    test("event order does not matter", () => {
        const a = couple([event("marriage", "2025-06-14"), event("legal_cohabitation", "2024-03-01")]);
        expect(deriveAssessment(a, 2025).decision.mode).toBe("joint");
    });
});
