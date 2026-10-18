import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    resolveBelgianTaxCalculation,
    resolveBelgianTaxHouseholdResult,
    resolveBelgianTaxProfile,
} from "@/stores/belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import {
    computeBelgianPIT,
    type BelgianTaxHouseholdV2,
    type BelgianTaxProfile,
} from "@/lib/belgianTax";

function householdOf(profile: BelgianTaxProfile): BelgianTaxHouseholdV2 {
    return runtime.upgradeProfileV1ToHousehold(profile);
}

function hydrate(
    profile: BelgianTaxProfile,
    snapshots: Record<number, BelgianTaxProfile> = {},
) {
    useSettingsStore
        .getState()
        ._hydrate(
            runtime,
            householdOf(profile),
            runtime.upgradeSnapshotsV1ToV2(snapshots),
            {},
        );
}

describe("Belgian tax settings slice", () => {
    beforeEach(() => {
        hydrate(DEFAULT_BELGIAN_TAX_PROFILE);
    });

    it("updates the live profile and calculation atomically", () => {
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        const state = useSettingsStore.getState();
        expect(state.profile.grossAnnualIncome).toBe(50_000);
        expect(state.calculation.grossIncome).toBe(50_000);
        expect(state.household?.partners[0]?.activities[0]?.grossIncome).toBe(
            50_000,
        );
        expect(state.householdResult?.totals.totalPIT).toBe(
            state.calculation.totalPIT,
        );
    });

    it("gives a one-partner household the same calculation as computeBelgianPIT on the projected profile", () => {
        hydrate({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            profileConfigured: true,
            grossAnnualIncome: 64_000,
            region: "brussels",
            dependentChildren: 2,
            personalPensionContributions: 1_020,
            pensionEligible: true,
            cadastralIncome: 1_250,
        });
        const state = useSettingsStore.getState();
        expect(state.household?.partners).toHaveLength(1);
        expect(state.calculation).toEqual(computeBelgianPIT(state.profile));

        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 41_500 });
        const updated = useSettingsStore.getState();
        expect(updated.calculation).toEqual(computeBelgianPIT(updated.profile));
    });

    it("computes a two-partner household through the household engine", () => {
        hydrate({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            grossAnnualIncome: 60_000,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 15_000,
        });
        const state = useSettingsStore.getState();
        expect(state.household?.partners.map((p) => p.id)).toEqual(["A", "B"]);
        expect(state.householdResult?.assessment.mode).toBe("joint");
        const result = runtime.computeHouseholdTax(state.household!);
        expect(state.calculation).toEqual(
            runtime.toBelgianTaxCalculation(result, state.household!),
        );
        expect(state.profile.filingStatus).toBe("married_joint");
        expect(state.profile.spouseProfessionalIncome).toBe(15_000);
    });

    it("archives an advancing profile and its audit entry atomically", () => {
        const year = useSettingsStore.getState().profile.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        useSettingsStore.getState().updateProfile({ taxYear: year + 1 });
        const state = useSettingsStore.getState();
        expect(state.snapshots[year]?.grossAnnualIncome).toBe(50_000);
        expect(state.householdSnapshots[year]?.taxYear).toBe(year);
        expect(
            state.snapshotMetas[year]?.history?.map((entry) => entry.kind),
        ).toEqual(["created"]);
    });

    it("resolves current snapshots and frozen calculations from reactive state", () => {
        const liveYear = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        const historicalYear = liveYear - 1;
        hydrate(
            { ...DEFAULT_BELGIAN_TAX_PROFILE, grossAnnualIncome: 60_000 },
            {
                [historicalYear]: {
                    ...DEFAULT_BELGIAN_TAX_PROFILE,
                    taxYear: historicalYear,
                    grossAnnualIncome: 45_000,
                },
            },
        );
        useSettingsStore.getState().freezeCalculation(historicalYear);

        const state = useSettingsStore.getState();
        expect(resolveBelgianTaxProfile(state, liveYear)).toBe(state.profile);
        expect(
            resolveBelgianTaxProfile(state, historicalYear).grossAnnualIncome,
        ).toBe(45_000);
        expect(resolveBelgianTaxCalculation(state, historicalYear)).toBe(
            state.snapshotMetas[historicalYear]!.frozenCalculation,
        );
    });
    it("records the configured live year and preserves its frozen record across reload and unfiling", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({
                profileConfigured: true,
                grossAnnualIncome: 50_000,
            });
        useSettingsStore.getState().freezeCalculation(year);
        const frozen = useSettingsStore.getState().getFrozenCalculation(year);
        useSettingsStore
            .getState()
            .markYearAsFiled(year, "synthetic-reference");
        const saved = useSettingsStore.getState();
        expect(saved.snapshots[year]?.grossAnnualIncome).toBe(50_000);
        expect(saved.snapshotMetas[year]?.filing?.reference).toBe(
            "synthetic-reference",
        );
        expect(saved.householdSnapshots[year]?.taxYear).toBe(year);
        useSettingsStore
            .getState()
            ._hydrate(
                runtime,
                saved.household!,
                saved.householdSnapshots,
                saved.snapshotMetas,
            );
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 60_000 });
        expect(useSettingsStore.getState().getFrozenCalculation(year)).toEqual(
            frozen,
        );
        useSettingsStore.getState().unmarkYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        expect(useSettingsStore.getState().getFrozenCalculation(year)).toEqual(
            frozen,
        );
        expect(
            useSettingsStore
                .getState()
                .getSnapshotHistory(year)
                .map((e) => e.kind),
        ).toEqual(["frozen", "filed", "unfiled"]);
    });

    it("requires a reviewed profile for historical filing instead of freezing a live-profile estimate", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().updateProfile({ profileConfigured: true });
        useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(true);
    });

    it("freezes the household result next to the calculation and drops both on unfreeze", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().freezeCalculation(year);
        const meta = useSettingsStore.getState().snapshotMetas[year]!;
        expect(meta.frozenHouseholdResult?.engineVersion).toBe(2);
        expect(meta.frozenHouseholdResult?.totals.totalPIT).toBe(
            meta.frozenCalculation?.totalPIT,
        );

        useSettingsStore.getState().unfreezeCalculation(year);
        const after = useSettingsStore.getState().snapshotMetas[year]!;
        expect(after.frozenCalculation).toBeUndefined();
        expect(after.frozenHouseholdResult).toBeUndefined();
    });

    it("records the household diff next to the profile diff when a snapshot is patched", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().updateSnapshot(year, {
            grossAnnualIncome: 30_000,
            region: "wallonia",
        });
        const entry = useSettingsStore
            .getState()
            .getSnapshotHistory(year)
            .at(-1)!;
        expect(entry.kind).toBe("patched");
        expect(entry.changes).toEqual({
            grossAnnualIncome: 30_000,
            region: "wallonia",
        });
        expect(entry.householdChanges?.region).toBe("wallonia");
        expect(
            entry.householdChanges?.partners?.[0]?.activities[0]?.grossIncome,
        ).toBe(30_000);
        expect(Object.keys(entry.householdChanges ?? {}).sort()).toEqual([
            "partners",
            "region",
        ]);
    });

    it("updateHousehold edits the live household and recomputes result, calculation and projection", () => {
        useSettingsStore.getState().updateHousehold((h) => {
            h.partners[0]!.activities.push({
                id: "act_A_2",
                kind: "self_employed_profits",
                grossIncome: 10_000,
            });
            h.partners[0]!.birthYear = 1980;
            return h;
        });
        let state = useSettingsStore.getState();
        expect(state.household?.partners[0]?.activities).toHaveLength(2);
        expect(state.household?.partners[0]?.birthYear).toBe(1980);
        expect(state.householdResult).toEqual(
            runtime.computeHouseholdTax(state.household!),
        );
        expect(state.calculation).toEqual(
            runtime.toBelgianTaxCalculation(
                state.householdResult!,
                state.household!,
            ),
        );
        expect(state.profile.grossAnnualIncome).toBe(10_000);

        useSettingsStore.getState().updateHousehold({ region: "wallonia" });
        state = useSettingsStore.getState();
        expect(state.household?.region).toBe("wallonia");
        expect(state.profile.region).toBe("wallonia");
    });

    it("updateHousehold adds and removes partner B and derives the assessment from events", () => {
        const before = useSettingsStore.getState().household!;
        useSettingsStore.getState().updateHousehold((h) => ({
            ...h,
            partners: [
                ...h.partners,
                {
                    id: "B",
                    isDisabled: false,
                    activities: [
                        { id: "act_B_1", kind: "employee", grossIncome: 20_000 },
                    ],
                    professionalExpenses: {},
                    unionDues: 0,
                    otherTaxableIncome: 0,
                    alimonyPaid: 0,
                    reductions: before.partners[0]!.reductions,
                },
            ],
            relationship: {
                events: [{ id: "evt_1", kind: "marriage", date: "2015-06-01" }],
            },
        }));
        let state = useSettingsStore.getState();
        expect(state.householdResult?.assessment.mode).toBe("joint");
        expect(state.profile.filingStatus).toBe("married_joint");

        useSettingsStore.getState().updateHousehold((h) => ({
            ...h,
            partners: h.partners.filter((p) => p.id === "A"),
            relationship: { events: [] },
        }));
        state = useSettingsStore.getState();
        expect(state.householdResult?.assessment.mode).toBe("single");
        expect(state.household).toEqual(before);
    });

    it("updateHousehold rejects a household that fails the settings schema", () => {
        const before = useSettingsStore.getState().household;
        useSettingsStore.getState().updateHousehold((h) => {
            h.relationship.events.push({
                id: "evt_1",
                kind: "marriage",
                date: "2015-13-40",
            });
            return h;
        });
        expect(useSettingsStore.getState().household).toBe(before);
    });

    it("updateHousehold does not mutate the previous household", () => {
        const before = useSettingsStore.getState().household!;
        const copy = structuredClone(before);
        useSettingsStore.getState().updateHousehold((h) => {
            h.partners[0]!.unionDues = 120;
            return h;
        });
        expect(before).toEqual(copy);
        expect(
            useSettingsStore.getState().household?.partners[0]?.unionDues,
        ).toBe(120);
    });

    it("updateHousehold archives the previous year when the income year advances", () => {
        const year = useSettingsStore.getState().household!.taxYear;
        useSettingsStore.getState().updateHousehold({ taxYear: year + 1 });
        const state = useSettingsStore.getState();
        expect(state.householdSnapshots[year]?.taxYear).toBe(year);
        expect(state.snapshots[year]?.taxYear).toBe(year);
        expect(
            state.snapshotMetas[year]?.history?.map((entry) => entry.kind),
        ).toEqual(["created"]);
    });

    it("updateHouseholdSnapshot keeps the year, recomputes the projection and audits the household diff", () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        useSettingsStore.getState().updateHouseholdSnapshot(year, (h) => {
            h.partners[0]!.activities[0]!.grossIncome = 42_000;
            h.taxYear = year + 5;
            return h;
        });
        const state = useSettingsStore.getState();
        expect(state.householdSnapshots[year]?.taxYear).toBe(year);
        expect(state.snapshots[year]?.grossAnnualIncome).toBe(42_000);
        expect(state.calculationForYear(year).grossIncome).toBe(42_000);
        const entry = state.getSnapshotHistory(year).at(-1)!;
        expect(entry.kind).toBe("patched");
        expect(entry.changes).toBeUndefined();
        expect(Object.keys(entry.householdChanges ?? {})).toEqual(["partners"]);

        // A no-op edit leaves the history alone.
        const length = state.getSnapshotHistory(year).length;
        useSettingsStore.getState().updateHouseholdSnapshot(year, (h) => h);
        expect(
            useSettingsStore.getState().getSnapshotHistory(year),
        ).toHaveLength(length);
    });

    it("updateHouseholdSnapshot ignores years without a snapshot", () => {
        const before = useSettingsStore.getState();
        useSettingsStore
            .getState()
            .updateHouseholdSnapshot(1999, { region: "brussels" });
        expect(useSettingsStore.getState().householdSnapshots).toBe(
            before.householdSnapshots,
        );
    });

    it("resolves the household result shown for a year: live, frozen or computed", () => {
        const liveYear = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        const year = liveYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        let state = useSettingsStore.getState();
        expect(resolveBelgianTaxHouseholdResult(state, liveYear)).toBe(
            state.householdResult,
        );
        expect(resolveBelgianTaxHouseholdResult(state, year)).toEqual(
            runtime.computeHouseholdTax(state.householdSnapshots[year]!),
        );
        useSettingsStore.getState().freezeCalculation(year);
        state = useSettingsStore.getState();
        expect(resolveBelgianTaxHouseholdResult(state, year)).toBe(
            state.snapshotMetas[year]!.frozenHouseholdResult,
        );
    });
});
