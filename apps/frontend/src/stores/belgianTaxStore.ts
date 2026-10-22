import type { StateCreator } from "@/stores/createStore";
import type { SettingsStore } from "@/stores/settingsStore";
// Type-only imports; every tax figure comes from the server (ADR-217).
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
// Type-only: the provider loads the household helpers lazily and passes them to `_hydrate`.
import type * as HouseholdRuntimeModule from "@/lib/belgianTax/householdRuntime";
import type { HouseholdUpdate } from "@/lib/belgianTax/householdRuntime";
import {
    computeBelgianTax,
    type BelgianTaxComputation,
} from "@/lib/api/belgianTax";

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
 * Household helpers handed over by `_hydrate`. Until the provider has loaded them the editing
 * actions are no-ops. Every tax figure comes from the server.
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
    /**
     * Server figures of the household the overview hydrated (not for a frozen live year), so
     * the first render needs no extra compute request. Edits are computed by the server.
     */
    hydratedComputation: HydratedComputation | null;
    /** v1 projection of `household` for v1-shaped editors and consumers. */
    profile: BelgianTaxProfile;
    /** v1 projection of `householdSnapshots`. */
    snapshots: BelgianTaxProfileSnapshots;
    snapshotMetas: BelgianTaxProfileSnapshotMetas;
    viewedYear: number;
    isViewingHistorical: boolean;
    isLoading: boolean;
    /** A stored household value was unreadable and replaced in memory; the next edit overwrites it. */
    storedHouseholdUnreadable: boolean;
    /** The household could not be loaded; editing is disabled and nothing is saved. */
    householdLoadFailed: boolean;
    saveErrorNonce: number;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    /** Edit the live household; invalid results (zod) are rejected and logged. */
    updateHousehold: (update: HouseholdUpdate) => void;
    resetProfile: () => void;
    setViewedYear: (year: number) => void;
    snapshotExistsForYear: (year: number) => boolean;
    profileForYear: (year: number) => BelgianTaxProfile;
    createSnapshotFromLive: (year: number) => void;
    updateSnapshot: (year: number, updates: Partial<BelgianTaxProfile>) => void;
    /** Edit the household snapshot of `year` (kept on that year); audited as `patched`. */
    updateHouseholdSnapshot: (year: number, update: HouseholdUpdate) => void;
    metaForYear: (year: number) => BelgianTaxProfileSnapshotMeta | null;
    isYearFiled: (year: number) => boolean;
    getFrozenCalculation: (year: number) => BelgianTaxCalculation | null;
    getSnapshotHistory: (year: number) => SnapshotAuditEntry[];
    /** Freeze the server's figures for `year`; rejects when the server could not compute them. */
    freezeCalculation: (year: number) => Promise<void>;
    unfreezeCalculation: (year: number) => void;
    /**
     * Record a filing in memory without persisting it first (persistTaxFiling is the
     * acknowledged path); an unfrozen year is frozen with the server's figures.
     */
    markYearAsFiled: (year: number, reference?: string) => Promise<void>;
    unmarkYearAsFiled: (year: number) => void;
    _hydrate: (
        runtime: HouseholdRuntime,
        household: BelgianTaxHouseholdV2,
        householdSnapshots: BelgianTaxHouseholdSnapshotsV2,
        metas: BelgianTaxProfileSnapshotMetas,
        storedHouseholdUnreadable?: boolean,
        hydratedComputation?: HydratedComputation | null,
    ) => void;
    _beginHydration: () => void;
    _markHydrationFailed: () => void;
    _markSaveError: () => void;
}

/** Server figures of one household, remembered with the household they belong to. */
export interface HydratedComputation {
    household: BelgianTaxHouseholdV2;
    computation: BelgianTaxComputation;
}

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

/**
 * Server figures of `year`'s household as it stands in `state` (POST /api/belgian-tax/compute),
 * in the stored frozen-metadata shape. `undefined` before hydration.
 */
export async function computeTaxYearResults(
    state: Pick<BelgianTaxSlice, "household" | "householdSnapshots">,
    year: number,
    signal?: AbortSignal,
): Promise<YearResults | undefined> {
    const household = resolveBelgianTaxHousehold(state, year);
    if (!household) return undefined;
    const { calculation, result } = await computeBelgianTax(household, signal);
    return { frozenCalculation: calculation, frozenHouseholdResult: result };
}

/** Figures of one year as an export shows them. */
export interface TaxYearFigures {
    calculation: BelgianTaxCalculation;
    /** `null` for a year frozen before household results were stored. */
    householdResult: HouseholdTaxResult | null;
}

/**
 * Figures of `year` for exports: the frozen ones when the year is frozen (never a recompute,
 * ADR-059), else the server's computation of the year's household. `undefined` before
 * hydration.
 */
export async function resolveTaxYearFigures(
    state: Pick<
        BelgianTaxSlice,
        "household" | "householdSnapshots" | "snapshotMetas"
    >,
    year: number,
): Promise<TaxYearFigures | undefined> {
    const meta = state.snapshotMetas[year];
    if (meta?.frozenCalculation)
        return {
            calculation: meta.frozenCalculation,
            householdResult: meta.frozenHouseholdResult ?? null,
        };
    const computed = await computeTaxYearResults(state, year);
    return (
        computed && {
            calculation: computed.frozenCalculation,
            householdResult: computed.frozenHouseholdResult ?? null,
        }
    );
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
    const live = {
        household: next,
        profile: runtime.projectProfileV1(next, DEFAULT_BELGIAN_TAX_PROFILE),
    };
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
    hydratedComputation: null,
    profile: DEFAULT_BELGIAN_TAX_PROFILE,
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
                household,
                profile: runtime.projectProfileV1(
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
    freezeCalculation: async (year) => {
        const frozen = await computeTaxYearResults(get(), year);
        if (!frozen) return;
        set((state) => {
            const { frozenHouseholdResult: _stale, ...existing } =
                state.snapshotMetas[year] ?? {};
            return {
                snapshotMetas: appendHistoryEntry(
                    {
                        ...state.snapshotMetas,
                        [year]: { ...existing, ...frozen },
                    },
                    year,
                    "frozen",
                ),
            };
        });
    },
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
    markYearAsFiled: async (year, reference) => {
        const state = get();
        if (!isTaxYearFileable(state, year)) return;
        const computed = state.snapshotMetas[year]?.frozenCalculation
            ? undefined
            : await computeTaxYearResults(state, year);
        set((current) =>
            buildFiledTaxState(current, year, reference, computed),
        );
    },
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
        hydratedComputation = null,
    ) => {
        householdRuntime = runtime;
        set({
            household,
            profile: runtime.projectProfileV1(
                household,
                DEFAULT_BELGIAN_TAX_PROFILE,
            ),
            hydratedComputation,
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
            hydratedComputation: null,
            profile: DEFAULT_BELGIAN_TAX_PROFILE,
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
 * A year is fileable when it is the live year, has its own household snapshot, or has an
 * explicitly frozen calculation, and holds meaningful data. A past year that would only use a
 * live estimate is refused.
 */
export function isTaxYearFileable(state: BelgianTaxSlice, year: number): boolean {
    const live = state.household;
    const existing = state.snapshotMetas[year];
    if (
        !householdRuntime ||
        !live ||
        state.isLoading ||
        state.householdLoadFailed ||
        existing?.filing
    )
        return false;
    if (
        year !== live.taxYear &&
        !Object.hasOwn(state.householdSnapshots, year) &&
        !existing?.frozenCalculation
    )
        return false;
    return hasMeaningfulBelgianTaxData(resolveBelgianTaxProfile(state, year));
}

/**
 * Prepare a filing without publishing it before persistence has acknowledged it.
 *
 * `computed` holds the server's figures for the year (computeTaxYearResults); they are frozen
 * next to the filing unless the year was already frozen. The state is returned unchanged when
 * the year is not fileable (isTaxYearFileable) or unfrozen figures are missing. The live year
 * is pinned as its own snapshot so the filed household survives later edits; a frozen year
 * without a snapshot is not pinned, because the live household would disagree with the frozen
 * figures.
 */
export function buildFiledTaxState(
    state: BelgianTaxSlice,
    year: number,
    reference?: string,
    computed?: YearResults,
): Partial<BelgianTaxSlice> {
    const runtime = householdRuntime;
    const live = state.household;
    const existing = state.snapshotMetas[year];
    if (!runtime || !live || !isTaxYearFileable(state, year)) return state;
    if (!existing?.frozenCalculation && !computed) return state;
    const isLiveYear = year === live.taxYear;
    const hasSnapshot = Object.hasOwn(state.householdSnapshots, year);
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
                    ...(existing?.frozenCalculation ? {} : computed),
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
