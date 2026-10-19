import { beforeEach, describe, expect, it } from "vitest";
import { useSettingsStore } from "@/stores/settingsStore";
import {
    computeTaxYearResults,
    DEFAULT_BELGIAN_TAX_PROFILE,
    resolveBelgianTaxProfile,
    resolveTaxYearFigures,
} from "@/stores/belgianTaxStore";
import * as runtime from "@/lib/belgianTax/householdRuntime";
import {
    upgradeProfileV1ToHousehold,
    upgradeSnapshotsV1ToV2,
} from "@/lib/belgianTax/householdMigration";
import type { BelgianTaxHouseholdV2, BelgianTaxProfile } from "@/lib/belgianTax";
// Test-only reference: the MSW compute route runs this engine, as the backend does.
import { computeHouseholdTax } from "@vision/shared-utils/belgian-tax/household";

function householdOf(profile: BelgianTaxProfile): BelgianTaxHouseholdV2 {
    return upgradeProfileV1ToHousehold(profile);
}

/** The server's figures for `year` of the current store state. */
async function serverFigures(year: number) {
    const results = await computeTaxYearResults(
        useSettingsStore.getState(),
        year,
    );
    if (!results) throw new Error("store not hydrated");
    return results;
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
            upgradeSnapshotsV1ToV2(snapshots),
            {},
        );
}

describe("Belgian tax settings slice", () => {
    beforeEach(() => {
        hydrate(DEFAULT_BELGIAN_TAX_PROFILE);
    });

    it("updates the live profile and household atomically, and the server computes the edit", async () => {
        useSettingsStore
            .getState()
            .updateProfile({ grossAnnualIncome: 50_000 });
        const state = useSettingsStore.getState();
        expect(state.profile.grossAnnualIncome).toBe(50_000);
        expect(state.household?.partners[0]?.activities[0]?.grossIncome).toBe(
            50_000,
        );
        const figures = await serverFigures(state.profile.taxYear);
        expect(figures.frozenCalculation.grossIncome).toBe(50_000);
        expect(figures.frozenHouseholdResult?.totals.totalPIT).toBe(
            figures.frozenCalculation.totalPIT,
        );
    });

    it("sends a two-partner household to the server and projects it onto the v1 profile", async () => {
        hydrate({
            ...DEFAULT_BELGIAN_TAX_PROFILE,
            grossAnnualIncome: 60_000,
            filingStatus: "married_joint",
            spouseProfessionalIncome: 15_000,
        });
        const state = useSettingsStore.getState();
        expect(state.household?.partners.map((p) => p.id)).toEqual(["A", "B"]);
        const figures = await serverFigures(state.profile.taxYear);
        expect(figures.frozenHouseholdResult?.assessment.mode).toBe("joint");
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

    it("resolves current snapshots and frozen calculations from reactive state", async () => {
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
        await useSettingsStore.getState().freezeCalculation(historicalYear);

        const state = useSettingsStore.getState();
        expect(resolveBelgianTaxProfile(state, liveYear)).toBe(state.profile);
        expect(
            resolveBelgianTaxProfile(state, historicalYear).grossAnnualIncome,
        ).toBe(45_000);
        expect(
            state.snapshotMetas[historicalYear]!.frozenCalculation?.grossIncome,
        ).toBe(45_000);
        expect(
            (await resolveTaxYearFigures(state, historicalYear))?.calculation,
        ).toBe(state.snapshotMetas[historicalYear]!.frozenCalculation);
    });
    it("records the configured live year and preserves its frozen record across reload and unfiling", async () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        useSettingsStore
            .getState()
            .updateProfile({
                profileConfigured: true,
                grossAnnualIncome: 50_000,
            });
        await useSettingsStore.getState().freezeCalculation(year);
        const frozen = useSettingsStore.getState().getFrozenCalculation(year);
        await useSettingsStore
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

    it("requires a reviewed profile for historical filing instead of freezing a live-profile estimate", async () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().updateProfile({ profileConfigured: true });
        await useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(false);
        useSettingsStore.getState().createSnapshotFromLive(year);
        await useSettingsStore.getState().markYearAsFiled(year);
        expect(useSettingsStore.getState().isYearFiled(year)).toBe(true);
    });

    it("freezes the household result next to the calculation and drops both on unfreeze", async () => {
        const year = DEFAULT_BELGIAN_TAX_PROFILE.taxYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        await useSettingsStore.getState().freezeCalculation(year);
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

    it("updateHousehold edits the live household and its projection; the server computes it", async () => {
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
        expect(state.profile.grossAnnualIncome).toBe(10_000);
        const figures = await serverFigures(state.household!.taxYear);
        expect(figures.frozenHouseholdResult).toEqual(
            JSON.parse(JSON.stringify(computeHouseholdTax(state.household!))),
        );

        useSettingsStore.getState().updateHousehold({ region: "wallonia" });
        state = useSettingsStore.getState();
        expect(state.household?.region).toBe("wallonia");
        expect(state.profile.region).toBe("wallonia");
    });

    it("updateHousehold adds and removes partner B and the server derives the assessment from events", async () => {
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
        const year = state.household!.taxYear;
        expect(
            (await serverFigures(year)).frozenHouseholdResult?.assessment.mode,
        ).toBe("joint");
        expect(state.profile.filingStatus).toBe("married_joint");

        useSettingsStore.getState().updateHousehold((h) => ({
            ...h,
            partners: h.partners.filter((p) => p.id === "A"),
            relationship: { events: [] },
        }));
        state = useSettingsStore.getState();
        expect(
            (await serverFigures(year)).frozenHouseholdResult?.assessment.mode,
        ).toBe("single");
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

    it("updateHouseholdSnapshot keeps the year, recomputes the projection and audits the household diff", async () => {
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
        expect((await serverFigures(year)).frozenCalculation.grossIncome).toBe(
            42_000,
        );
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

    it("resolves the figures exported for a year: computed by the server, or frozen", async () => {
        const liveYear = DEFAULT_BELGIAN_TAX_PROFILE.taxYear;
        const year = liveYear - 1;
        useSettingsStore.getState().createSnapshotFromLive(year);
        let state = useSettingsStore.getState();
        expect(
            (await resolveTaxYearFigures(state, liveYear))?.householdResult,
        ).toEqual(JSON.parse(JSON.stringify(computeHouseholdTax(state.household!))));
        expect(
            (await resolveTaxYearFigures(state, year))?.householdResult,
        ).toEqual(
            JSON.parse(
                JSON.stringify(
                    computeHouseholdTax(state.householdSnapshots[year]!),
                ),
            ),
        );
        await useSettingsStore.getState().freezeCalculation(year);
        state = useSettingsStore.getState();
        expect((await resolveTaxYearFigures(state, year))?.householdResult).toBe(
            state.snapshotMetas[year]!.frozenHouseholdResult,
        );
    });
});
