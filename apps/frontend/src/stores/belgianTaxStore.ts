import type { StateCreator } from "zustand";
import type { SettingsStore } from "@/stores/settingsStore";
// Value imports by path, not through the `@/lib/belgianTax` barrel: the barrel also re-exports
// the household engine, and a boot-path import of it pulls that engine into the boot chunk
// once the lazily loaded householdRuntime uses it (see scripts/check-bundle-size.ts).
import { computeBelgianPIT } from "@/lib/belgianTax/pit";
import type {
    BelgianTaxCalculation,
    BelgianTaxHouseholdSnapshotsV2,
    BelgianTaxHouseholdV2,
    BelgianTaxProfile,
    HouseholdTaxResult,
    BelgianTaxProfileSnapshotMeta,
    BelgianTaxProfileSnapshotMetas,
    BelgianTaxProfileSnapshots,
    SnapshotAuditEntry,
    SnapshotAuditEntryKind,
} from "@/lib/belgianTax";
// Type-only: the provider loads the household engine lazily and passes it to `_hydrate`.
import type * as HouseholdRuntimeModule from "@/lib/belgianTax/householdRuntime";
import type { HouseholdUpdate } from "@/lib/belgianTax/householdRuntime";

export type HouseholdRuntime = typeof HouseholdRuntimeModule;

export type { HouseholdUpdate };

const MAX_HISTORY_ENTRIES_PER_YEAR = 200;

import {
    DEFAULT_BELGIAN_TAX_PROFILE,
    hasMeaningfulBelgianTaxData,
} from "@vision/shared-utils/belgian-tax/profileDefaults";
export {
    DEFAULT_BELGIAN_TAX_PROFILE,
    hasMeaningfulBelgianTaxData,
} from "@vision/shared-utils/belgian-tax/profileDefaults";

/**
 * Household engine handed over by `_hydrate`. Until the provider has loaded it, the year
 * resolvers fall back to `computeBelgianPIT` on the v1 projection (the defaults are a
 * one-partner household, for which both engines agree) and the editing actions are no-ops.
 */
let householdRuntime: HouseholdRuntime | undefined;

function appendHistoryEntry(
    metas: BelgianTaxProfileSnapshotMetas,
    year: number,
    kind: SnapshotAuditEntryKind,
    extras?: Omit<SnapshotAuditEntry, "at" | "kind">,
): BelgianTaxProfileSnapshotMetas {
    const existing = metas[year];
    const history = [
        ...(existing?.history ?? []),
        { at: new Date().toISOString(), kind, ...extras },
    ];
    return {
        ...metas,
        [year]: {
            ...(existing ?? {}),
            history: history.slice(-MAX_HISTORY_ENTRIES_PER_YEAR),
        },
    };
}

export interface BelgianTaxSlice {
    /** Source of truth (ADR-200): the live household; `null` until hydrated. */
    household: BelgianTaxHouseholdV2 | null;
    /** Source of truth: year snapshots of the household. */
    householdSnapshots: BelgianTaxHouseholdSnapshotsV2;
    /** Raw engine result of the live household (per partner, quotient, CSSS, issues). */
    householdResult: HouseholdTaxResult | null;
    /** v1 projection of `household` for v1-shaped editors and consumers. */
    profile: BelgianTaxProfile;
    /** v1-shaped calculation of the live household. */
    calculation: BelgianTaxCalculation;
    /** v1 projection of `householdSnapshots`. */
    snapshots: BelgianTaxProfileSnapshots;
    snapshotMetas: BelgianTaxProfileSnapshotMetas;
    viewedYear: number;
    isViewingHistorical: boolean;
    isLoading: boolean;
    /** A stored household value was unreadable and replaced in memory; the next edit overwrites it. */
    storedHouseholdUnreadable: boolean;
    /** The household engine chunk failed to load; editing is disabled and nothing is saved. */
    householdLoadFailed: boolean;
    saveErrorNonce: number;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    /** Edit the live household; invalid results (zod) are rejected and logged. */
    updateHousehold: (update: HouseholdUpdate) => void;
    resetProfile: () => void;
    setViewedYear: (year: number) => void;
    snapshotExistsForYear: (year: number) => boolean;
    profileForYear: (year: number) => BelgianTaxProfile;
    calculationForYear: (year: number) => BelgianTaxCalculation;
    displayCalculationForYear: (year: number) => BelgianTaxCalculation;
    createSnapshotFromLive: (year: number) => void;
    updateSnapshot: (year: number, updates: Partial<BelgianTaxProfile>) => void;
    /** Edit the household snapshot of `year` (kept on that year); audited as `patched`. */
    updateHouseholdSnapshot: (year: number, update: HouseholdUpdate) => void;
    metaForYear: (year: number) => BelgianTaxProfileSnapshotMeta | null;
    isYearFiled: (year: number) => boolean;
    getFrozenCalculation: (year: number) => BelgianTaxCalculation | null;
    getSnapshotHistory: (year: number) => SnapshotAuditEntry[];
    freezeCalculation: (year: number) => void;
    unfreezeCalculation: (year: number) => void;
    markYearAsFiled: (year: number, reference?: string) => void;
    unmarkYearAsFiled: (year: number) => void;
    _hydrate: (
        runtime: HouseholdRuntime,
        household: BelgianTaxHouseholdV2,
        householdSnapshots: BelgianTaxHouseholdSnapshotsV2,
        metas: BelgianTaxProfileSnapshotMetas,
        storedHouseholdUnreadable?: boolean,
    ) => void;
    _beginHydration: () => void;
    _markHydrationFailed: () => void;
    _markSaveError: () => void;
}

type YearState = Pick<
    BelgianTaxSlice,
    "profile" | "snapshots" | "household" | "householdSnapshots"
>;

export function resolveBelgianTaxProfile(
    state: Pick<BelgianTaxSlice, "profile" | "snapshots">,
    year: number,
): BelgianTaxProfile {
    if (year === state.profile.taxYear) return state.profile;
    return state.snapshots[year] ?? { ...state.profile, taxYear: year };
}

/** Household for `year`: the live one, its snapshot, or the live one moved to that year. */
export function resolveBelgianTaxHousehold(
    state: Pick<BelgianTaxSlice, "household" | "householdSnapshots">,
    year: number,
): BelgianTaxHouseholdV2 | null {
    const live = state.household;
    if (!live) return null;
    if (year === live.taxYear) return live;
    return state.householdSnapshots[year] ?? { ...live, taxYear: year };
}

type YearResults = Pick<
    BelgianTaxProfileSnapshotMeta,
    "frozenHouseholdResult"
> & {
    frozenCalculation: BelgianTaxCalculation;
};

function computeYearResults(
    state: YearState,
    year: number,
    runtime: HouseholdRuntime | undefined = householdRuntime,
): YearResults {
    const household = resolveBelgianTaxHousehold(state, year);
    if (runtime && household) {
        const result = runtime.computeHouseholdTax(household);
        return {
            frozenCalculation: runtime.toBelgianTaxCalculation(
                result,
                household,
            ),
            frozenHouseholdResult: result,
        };
    }
    return {
        frozenCalculation: computeBelgianPIT(
            resolveBelgianTaxProfile(state, year),
        ),
    };
}

/**
 * Calculation of `year`'s household with a v1 patch applied (e.g. a chart bar's gross income on
 * partner A's primary activity), through the loaded engine; `undefined` before hydration.
 */
export function calculateBelgianTaxHouseholdWithPatch(
    state: Pick<BelgianTaxSlice, "household" | "householdSnapshots">,
    year: number,
    patch: Partial<BelgianTaxProfile>,
): BelgianTaxCalculation | undefined {
    const runtime = householdRuntime;
    const household = resolveBelgianTaxHousehold(state, year);
    if (!runtime || !household) return undefined;
    const next: BelgianTaxHouseholdV2 = {
        ...runtime.applyProfileV1PatchToHousehold(household, patch),
        taxYear: year,
    };
    return runtime.toBelgianTaxCalculation(
        runtime.computeHouseholdTax(next),
        next,
    );
}

export function resolveBelgianTaxCalculation(
    state: YearState & Pick<BelgianTaxSlice, "snapshotMetas">,
    year: number,
    runtime?: HouseholdRuntime,
): BelgianTaxCalculation {
    return (
        state.snapshotMetas[year]?.frozenCalculation ??
        computeYearResults(state, year, runtime).frozenCalculation
    );
}

/**
 * Household engine result shown for `year`, alongside `resolveBelgianTaxCalculation`: the
 * frozen one when the year is frozen, else the live result or a fresh computation. `null`
 * until the provider has loaded the engine.
 */
export function resolveBelgianTaxHouseholdResult(
    state: YearState &
        Pick<BelgianTaxSlice, "snapshotMetas" | "householdResult">,
    year: number,
    runtime?: HouseholdRuntime,
): HouseholdTaxResult | null {
    const frozen = state.snapshotMetas[year]?.frozenHouseholdResult;
    if (frozen) return frozen;
    if (state.household && year === state.household.taxYear)
        return state.householdResult;
    return computeYearResults(state, year, runtime).frozenHouseholdResult ?? null;
}

/**
 * State after replacing the live household `current` with `next`: recomputed result,
 * calculation and projection. Advancing the income year archives `current` as the snapshot of
 * its year when none exists yet.
 */
function commitLiveHousehold(
    runtime: HouseholdRuntime,
    state: BelgianTaxSlice,
    current: BelgianTaxHouseholdV2,
    next: BelgianTaxHouseholdV2,
): Partial<BelgianTaxSlice> {
    const live = runtime.liveHouseholdState(next, DEFAULT_BELGIAN_TAX_PROFILE);
    const isViewingHistorical = state.viewedYear !== next.taxYear;
    const year = current.taxYear;
    if (next.taxYear <= year || state.householdSnapshots[year])
        return { ...live, isViewingHistorical };
    const householdSnapshots = { ...state.householdSnapshots, [year]: current };
    return {
        ...live,
        isViewingHistorical,
        householdSnapshots,
        snapshots: runtime.projectSnapshotsToV1(
            householdSnapshots,
            DEFAULT_BELGIAN_TAX_PROFILE,
        ),
        snapshotMetas: appendHistoryEntry(state.snapshotMetas, year, "created"),
    };
}

export const createBelgianTaxSlice: StateCreator<
    SettingsStore,
    [],
    [],
    BelgianTaxSlice
> = (set, get) => ({
    household: null,
    householdSnapshots: {},
    householdResult: null,
    profile: DEFAULT_BELGIAN_TAX_PROFILE,
    calculation: computeBelgianPIT(DEFAULT_BELGIAN_TAX_PROFILE),
    snapshots: {},
    snapshotMetas: {},
    viewedYear: DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
    isViewingHistorical: false,
    isLoading: true,
    storedHouseholdUnreadable: false,
    householdLoadFailed: false,
    saveErrorNonce: 0,

    updateProfile: (updates) =>
        set((state) => {
            const runtime = householdRuntime;
            const current = state.household;
            if (!runtime || !current) return state;
            return commitLiveHousehold(
                runtime,
                state,
                current,
                runtime.applyProfileV1PatchToHousehold(current, updates),
            );
        }),
    updateHousehold: (update) =>
        set((state) => {
            const runtime = householdRuntime;
            const current = state.household;
            if (!runtime || !current) return state;
            const next = runtime.applyHouseholdUpdate(current, update);
            return next
                ? commitLiveHousehold(runtime, state, current, next)
                : state;
        }),
    resetProfile: () =>
        set((state) => {
            const runtime = householdRuntime;
            if (!runtime) return state;
            const household = runtime.defaultHousehold(
                DEFAULT_BELGIAN_TAX_PROFILE,
            );
            return {
                ...runtime.liveHouseholdState(
                    household,
                    DEFAULT_BELGIAN_TAX_PROFILE,
                ),
                isViewingHistorical: state.viewedYear !== household.taxYear,
            };
        }),
    setViewedYear: (viewedYear) =>
        set((state) => ({
            viewedYear,
            isViewingHistorical: viewedYear !== state.profile.taxYear,
        })),
    snapshotExistsForYear: (year) =>
        Object.prototype.hasOwnProperty.call(get().householdSnapshots, year),
    profileForYear: (year) => resolveBelgianTaxProfile(get(), year),
    calculationForYear: (year) =>
        computeYearResults(get(), year).frozenCalculation,
    displayCalculationForYear: (year) =>
        resolveBelgianTaxCalculation(get(), year),
    createSnapshotFromLive: (year) =>
        set((state) => {
            const runtime = householdRuntime;
            const live = state.household;
            if (!runtime || !live || state.householdSnapshots[year])
                return state;
            const householdSnapshots = {
                ...state.householdSnapshots,
                [year]: { ...structuredClone(live), taxYear: year },
            };
            return {
                householdSnapshots,
                snapshots: runtime.projectSnapshotsToV1(
                    householdSnapshots,
                    DEFAULT_BELGIAN_TAX_PROFILE,
                ),
                snapshotMetas: appendHistoryEntry(
                    state.snapshotMetas,
                    year,
                    "created",
                ),
            };
        }),
    updateSnapshot: (year, updates) =>
        set((state) => {
            const runtime = householdRuntime;
            const existing = state.householdSnapshots[year];
            if (!runtime || !existing) return state;
            const { taxYear: _ignored, ...changes } = updates;
            const next: BelgianTaxHouseholdV2 = {
                ...runtime.applyProfileV1PatchToHousehold(existing, changes),
                taxYear: year,
            };
            const householdChanges = runtime.diffHousehold(existing, next);
            const householdSnapshots = {
                ...state.householdSnapshots,
                [year]: next,
            };
            return {
                householdSnapshots,
                snapshots: runtime.projectSnapshotsToV1(
                    householdSnapshots,
                    DEFAULT_BELGIAN_TAX_PROFILE,
                ),
                snapshotMetas:
                    Object.keys(changes).length > 0
                        ? appendHistoryEntry(
                              state.snapshotMetas,
                              year,
                              "patched",
                              Object.keys(householdChanges).length > 0
                                  ? { changes, householdChanges }
                                  : { changes },
                          )
                        : state.snapshotMetas,
            };
        }),
    updateHouseholdSnapshot: (year, update) =>
        set((state) => {
            const runtime = householdRuntime;
            const existing = state.householdSnapshots[year];
            if (!runtime || !existing) return state;
            const updated = runtime.applyHouseholdUpdate(existing, update);
            if (!updated) return state;
            // The snapshot stays pinned to its key year.
            const next: BelgianTaxHouseholdV2 = { ...updated, taxYear: year };
            const householdChanges = runtime.diffHousehold(existing, next);
            if (Object.keys(householdChanges).length === 0) return state;
            const householdSnapshots = {
                ...state.householdSnapshots,
                [year]: next,
            };
            return {
                householdSnapshots,
                snapshots: runtime.projectSnapshotsToV1(
                    householdSnapshots,
                    DEFAULT_BELGIAN_TAX_PROFILE,
                ),
                snapshotMetas: appendHistoryEntry(
                    state.snapshotMetas,
                    year,
                    "patched",
                    { householdChanges },
                ),
            };
        }),
    metaForYear: (year) => get().snapshotMetas[year] ?? null,
    isYearFiled: (year) => !!get().snapshotMetas[year]?.filing,
    getFrozenCalculation: (year) =>
        get().snapshotMetas[year]?.frozenCalculation ?? null,
    getSnapshotHistory: (year) => get().snapshotMetas[year]?.history ?? [],
    freezeCalculation: (year) =>
        set((state) => {
            const { frozenHouseholdResult: _stale, ...existing } =
                state.snapshotMetas[year] ?? {};
            return {
                snapshotMetas: appendHistoryEntry(
                    {
                        ...state.snapshotMetas,
                        [year]: {
                            ...existing,
                            ...computeYearResults(state, year),
                        },
                    },
                    year,
                    "frozen",
                ),
            };
        }),
    unfreezeCalculation: (year) =>
        set((state) => {
            const existing = state.snapshotMetas[year];
            if (!existing?.frozenCalculation) return state;
            const {
                frozenCalculation: _calculation,
                frozenHouseholdResult: _result,
                ...rest
            } = existing;
            return {
                snapshotMetas: appendHistoryEntry(
                    { ...state.snapshotMetas, [year]: rest },
                    year,
                    "unfrozen",
                ),
            };
        }),
    markYearAsFiled: (year, reference) =>
        set((state) => buildFiledTaxState(state, year, reference)),
    unmarkYearAsFiled: (year) =>
        set((state) => {
            const existing = state.snapshotMetas[year];
            if (!existing?.filing) return state;
            const { filing: _ignored, ...rest } = existing;
            return {
                snapshotMetas: appendHistoryEntry(
                    { ...state.snapshotMetas, [year]: rest },
                    year,
                    "unfiled",
                ),
            };
        }),
    _hydrate: (
        runtime,
        household,
        householdSnapshots,
        snapshotMetas,
        storedHouseholdUnreadable = false,
    ) => {
        householdRuntime = runtime;
        set({
            ...runtime.liveHouseholdState(
                household,
                DEFAULT_BELGIAN_TAX_PROFILE,
            ),
            householdSnapshots,
            snapshots: runtime.projectSnapshotsToV1(
                householdSnapshots,
                DEFAULT_BELGIAN_TAX_PROFILE,
            ),
            snapshotMetas,
            viewedYear: household.taxYear,
            isViewingHistorical: false,
            isLoading: false,
            storedHouseholdUnreadable,
            householdLoadFailed: false,
        });
    },
    _beginHydration: () =>
        set({
            household: null,
            householdSnapshots: {},
            householdResult: null,
            profile: DEFAULT_BELGIAN_TAX_PROFILE,
            calculation: computeBelgianPIT(DEFAULT_BELGIAN_TAX_PROFILE),
            snapshots: {},
            snapshotMetas: {},
            viewedYear: DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
            isViewingHistorical: false,
            isLoading: true,
            storedHouseholdUnreadable: false,
            householdLoadFailed: false,
            saveErrorNonce: 0,
        }),
    _markHydrationFailed: () =>
        set({ isLoading: false, householdLoadFailed: true }),
    _markSaveError: () =>
        set((state) => ({ saveErrorNonce: state.saveErrorNonce + 1 })),
});

/**
 * Prepare a filing without publishing it before persistence has acknowledged it.
 *
 * A year is fileable when it is the live year, has its own household snapshot, or has an
 * explicitly frozen calculation. A past year that would only use a live estimate is refused.
 * The live year is pinned as its own snapshot so the filed household survives later edits; a
 * frozen year without a snapshot is not pinned, because the live household would disagree with
 * the frozen figures. Results are frozen next to the filing unless the year was already frozen.
 */
export function buildFiledTaxState(
    state: BelgianTaxSlice,
    year: number,
    reference?: string,
): Partial<BelgianTaxSlice> {
    const runtime = householdRuntime;
    const live = state.household;
    const existing = state.snapshotMetas[year];
    if (
        !runtime ||
        !live ||
        state.isLoading ||
        state.householdLoadFailed ||
        existing?.filing
    )
        return state;
    const isLiveYear = year === live.taxYear;
    const hasSnapshot = Object.hasOwn(state.householdSnapshots, year);
    if (!isLiveYear && !hasSnapshot && !existing?.frozenCalculation)
        return state;
    if (!hasMeaningfulBelgianTaxData(resolveBelgianTaxProfile(state, year)))
        return state;
    const householdSnapshots =
        isLiveYear && !hasSnapshot
            ? {
                  ...state.householdSnapshots,
                  [year]: { ...structuredClone(live), taxYear: year },
              }
            : state.householdSnapshots;
    const filing = {
        filedAt: new Date().toISOString(),
        ...(reference ? { reference } : {}),
    };
    return {
        ...(householdSnapshots !== state.householdSnapshots
            ? {
                  householdSnapshots,
                  snapshots: runtime.projectSnapshotsToV1(
                      householdSnapshots,
                      DEFAULT_BELGIAN_TAX_PROFILE,
                  ),
              }
            : {}),
        snapshotMetas: appendHistoryEntry(
            {
                ...state.snapshotMetas,
                [year]: {
                    ...(existing ?? {}),
                    filing,
                    ...(existing?.frozenCalculation
                        ? {}
                        : computeYearResults(state, year)),
                },
            },
            year,
            "filed",
            reference ? { reference } : undefined,
        ),
    };
}

/**
 * Publish one acknowledged filing onto the current state, leaving other years and the live
 * household as they are now.
 */
export function publishFiledYear(
    current: BelgianTaxSlice,
    year: number,
    filedHousehold: BelgianTaxHouseholdV2 | undefined,
    filedMeta: BelgianTaxProfileSnapshotMeta,
): Partial<BelgianTaxSlice> {
    const snapshotMetas = { ...current.snapshotMetas, [year]: filedMeta };
    const runtime = householdRuntime;
    if (!filedHousehold || !runtime) return { snapshotMetas };
    const householdSnapshots = {
        ...current.householdSnapshots,
        [year]: filedHousehold,
    };
    return {
        householdSnapshots,
        snapshots: runtime.projectSnapshotsToV1(
            householdSnapshots,
            DEFAULT_BELGIAN_TAX_PROFILE,
        ),
        snapshotMetas,
    };
}
