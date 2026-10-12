import { describe, expect, test } from "vitest";
import { upgradeProfileV1ToHousehold } from "@/lib/belgianTax/householdMigration";
import { parseHouseholdV2 } from "@/lib/belgianTax/householdSchema";
import type { BelgianTaxHouseholdV2 } from "@/lib/belgianTax/householdTypes";
import { DEFAULT_BELGIAN_TAX_PROFILE } from "@/stores/belgianTaxStore";
import {
    addActivity,
    addPartnerB,
    addRelationshipEvent,
    expenseCategories,
    removeActivity,
    removePartnerB,
    updateActivity,
    updateRelationshipEvent,
} from "../profile-steps/householdEditing";

const base = (): BelgianTaxHouseholdV2 =>
    upgradeProfileV1ToHousehold({ ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 40_000 });

const valid = (h: BelgianTaxHouseholdV2) => expect(parseHouseholdV2(h).ok).toBe(true);

describe("householdEditing", () => {
    test("activity ids stay unique and expense choices follow the used categories", () => {
        let h = addActivity(base(), "A", "self_employed_profits");
        h = addActivity(h, "A");
        expect(h.partners[0]!.activities.map((a) => a.id)).toEqual(["act_A_1", "act_A_2", "act_A_3"]);
        expect(expenseCategories(h.partners[0]!)).toEqual(["remuneration", "profits"]);
        h = {
            ...h,
            partners: [
                {
                    ...h.partners[0]!,
                    professionalExpenses: {
                        ...h.partners[0]!.professionalExpenses,
                        profits: { method: "actual", actualAmount: 2_000 },
                    },
                },
            ],
        };
        h = removeActivity(h, "A", "act_A_2");
        expect(Object.keys(h.partners[0]!.professionalExpenses)).toEqual(["remuneration"]);
        valid(h);
    });

    test("switching to and from a net amount moves the amount and drops the net field", () => {
        let h = updateActivity(base(), "A", "act_A_1", { kind: "net_professional_amount" });
        expect(h.partners[0]!.activities[0]).toEqual({
            id: "act_A_1",
            kind: "net_professional_amount",
            grossIncome: 0,
            netProfessionalIncome: 40_000,
        });
        valid(h);
        h = updateActivity(h, "A", "act_A_1", { kind: "pension" });
        expect(h.partners[0]!.activities[0]).toEqual({ id: "act_A_1", kind: "pension", grossIncome: 40_000 });
        valid(h);
    });

    test("changing the kind away from a pension drops the pension type", () => {
        let h = updateActivity(base(), "A", "act_A_1", { kind: "pension" });
        h = updateActivity(h, "A", "act_A_1", { pensionKind: "statutory_from_legal_age" });
        expect(h.partners[0]!.activities[0]!.pensionKind).toBe("statutory_from_legal_age");
        valid(h);
        // Re-selecting the same kind keeps it.
        h = updateActivity(h, "A", "act_A_1", { kind: "pension" });
        expect(h.partners[0]!.activities[0]!.pensionKind).toBe("statutory_from_legal_age");
        h = updateActivity(h, "A", "act_A_1", { kind: "employee" });
        expect(h.partners[0]!.activities[0]).toEqual({ id: "act_A_1", kind: "employee", grossIncome: 40_000 });
        valid(h);
    });

    test("an undefined patch value clears an optional field", () => {
        let h = updateActivity(base(), "A", "act_A_1", { startDate: "2025-03-01" });
        expect(h.partners[0]!.activities[0]!.startDate).toBe("2025-03-01");
        h = updateActivity(h, "A", "act_A_1", { startDate: undefined });
        expect(h.partners[0]!.activities[0]).not.toHaveProperty("startDate");
    });

    test("removing partner B clears every reference to B and keeps the couple's events", () => {
        let h = addPartnerB(base());
        h = addRelationshipEvent(h, "marriage", "2015-06-01");
        h = addRelationshipEvent(h, "death", "2025-02-01");
        h = {
            ...h,
            dependents: { ...h.dependents, claimantPartnerId: "B" },
            home: { ...h.home, mortgageCreditPartnerId: "B" },
            relationship: { ...h.relationship, deathYearElection: "joint" },
        };
        valid(h);
        const removed = removePartnerB(h);
        expect(removed.partners.map((p) => p.id)).toEqual(["A"]);
        expect(removed.relationship).toEqual({
            events: [{ id: "evt_1", kind: "marriage", date: "2015-06-01" }],
        });
        expect(removed.dependents.claimantPartnerId).toBe("A");
        expect(removed.home.mortgageCreditPartnerId).toBe("A");
        valid(removed);
    });

    test("removing partner B drops a migrated spouse-disability field", () => {
        const migrated = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            filingStatus: "single",
            isSpouseDisabled: true,
        });
        const removed = removePartnerB(addPartnerB(migrated));
        expect(removed.migratedFrom?.unmappedFields.map((f) => f.field)).not.toContain(
            "isSpouseDisabled",
        );
        valid(removed);
    });

    test("a recorded event replaces the legacy joint assumption; death events name a partner", () => {
        const legacy = upgradeProfileV1ToHousehold({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 10_000,
        });
        expect(legacy.relationship.legacyAssumedJoint).toBe(true);
        let h = addRelationshipEvent(legacy, "legal_cohabitation", "2012-01-01");
        expect(h.relationship.legacyAssumedJoint).toBeUndefined();
        h = updateRelationshipEvent(h, "evt_1", { kind: "death" });
        expect(h.relationship.events[0]!.partnerId).toBe("B");
        h = updateRelationshipEvent(h, "evt_1", { kind: "divorce" });
        expect(h.relationship.events[0]).not.toHaveProperty("partnerId");
        valid(h);
    });
});
