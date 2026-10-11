import { describe, expect, it } from "vitest";
import { summarizeHouseholdChanges, summarizePatch } from "../historySummary";
import { activity, partner } from "@/lib/belgianTax/__tests__/testHousehold";

const labels: Record<string, string> = {
    "tax.household.partner.A": "You",
    "tax.household.partner.B": "Partner",
    "tax.history.household.section.partners": "Partners and income",
    "tax.history.household.section.region": "Region",
    "tax.history.household.section.dependents": "Dependants",
    "tax.history.household.partnerSummary": "{partner}, {count} activities, gross {gross}",
    "tax.history.household.dependentsSummary": "{children} children, {others} other dependants",
    "tax.profile.region.wallonia.label": "Wallonia",
};
const t = ((key: string, vars?: Record<string, string | number>) => {
    let text = labels[key] ?? key;
    for (const [k, v] of Object.entries(vars ?? {})) text = text.replace(`{${k}}`, String(v));
    return text;
}) as Parameters<typeof summarizeHouseholdChanges>[1];
const fmt = (value: number) => `EUR ${value}`;

describe("summarizeHouseholdChanges", () => {
    it("writes one readable line per changed section in a fixed order", () => {
        const lines = summarizeHouseholdChanges(
            {
                region: "wallonia",
                partners: [
                    partner("A", [activity("employee", 40_000), activity("pension", 2_000)]),
                    partner("B", [activity("net_professional_amount", 9_000)], {
                        displayName: "Sam",
                    }),
                ],
                dependents: { children: 2, otherPersons: 1 },
            },
            t,
            fmt,
        );
        expect(lines).toEqual([
            "Partners and income: You, 2 activities, gross EUR 42000; Sam, 1 activities, gross EUR 9000",
            "Dependants: 2 children, 1 other dependants",
            "Region: Wallonia",
        ]);
    });

    it("keeps unknown keys in the compact summary", () => {
        expect(
            summarizeHouseholdChanges({ migratedFrom: { fromVersion: 1, unmappedFields: [] } }, t, fmt),
        ).toEqual(["migratedFrom: {2 keys}"]);
        expect(summarizePatch({ grossAnnualIncome: 5 })).toBe("grossAnnualIncome: 5");
    });
});
