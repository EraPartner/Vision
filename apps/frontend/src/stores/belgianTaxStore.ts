import type { StateCreator } from "zustand";
import type { SettingsStore } from "@/stores/settingsStore";
import {
    computeBelgianPIT,
    LATEST_TAX_YEAR,
    type BelgianTaxCalculation,
    type BelgianTaxProfile,
    type BelgianTaxProfileSnapshotMeta,
    type BelgianTaxProfileSnapshotMetas,
    type BelgianTaxProfileSnapshots,
    type SnapshotAuditEntry,
    type SnapshotAuditEntryKind,
} from "@/lib/belgianTax";

const MAX_HISTORY_ENTRIES_PER_YEAR = 200;

export const DEFAULT_BELGIAN_TAX_PROFILE: BelgianTaxProfile = {
    profileConfigured: false,
    employmentType: "employee",
    grossAnnualIncome: 0,
    professionalExpenseMethod: "lump_sum",
    actualProfessionalExpenses: 0,
    communalSurchargePercent: 7,
    region: "flanders",
    dependentChildren: 0,
    dependentChildrenUnder3: 0,
    dependentChildrenDisabled: 0,
    dependentOtherPersons: 0,
    dependentOtherPersonsDisabled: 0,
    isDisabled: false,
    isSpouseDisabled: false,
    isIsolatedParent: false,
    cadastralIncome: 0,
    additionalResidences: [],
    otherTaxableIncome: 0,
    alimonyPaid: 0,
    personalPensionContributions: 0,
    pensionScheme: "1050",
    pensionEligible: false,
    lifeInsurancePremiums: 0,
    lifeInsuranceEligible: false,
    mortgageInterestPaid: 0,
    mortgageCapitalRepaid: 0,
    mortgageStartYear: undefined,
    mortgageRegion: undefined,
    mortgageIsPrimaryResidence: false,
    charitableDonations: 0,
    charitableDonationsEligible: false,
    childcareCosts: 0,
    childcareEligibleDays: 0,
    childcareEligible: false,
    employeeGroupInsuranceContributions: 0,
    employeeGroupInsuranceEligible: false,
    unionDues: 0,
    medicalExpenses: 0,
    domesticHelpCosts: 0,
    domesticHelpEligible: false,
    serviceVoucherCount: 0,
    serviceVoucherEligible: false,
    filingStatus: "single",
    spouseProfessionalIncome: 0,
    annualDividendIncome: 0,
    annualSavingsInterest: 0,
    taxIncomeCategoryIds: [],
    taxYear: LATEST_TAX_YEAR,
};

export function hasMeaningfulBelgianTaxData(
    profile: BelgianTaxProfile,
): boolean {
    return (
        profile.profileConfigured === true ||
        (profile.grossAnnualIncome ?? 0) > 0 ||
        (profile.otherTaxableIncome ?? 0) > 0 ||
        (profile.cadastralIncome ?? 0) > 0 ||
        (profile.dependentChildren ?? 0) > 0 ||
        (profile.dependentOtherPersons ?? 0) > 0 ||
        (profile.actualProfessionalExpenses ?? 0) > 0
    );
}

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
    profile: BelgianTaxProfile;
    calculation: BelgianTaxCalculation;
    snapshots: BelgianTaxProfileSnapshots;
    snapshotMetas: BelgianTaxProfileSnapshotMetas;
    viewedYear: number;
    isViewingHistorical: boolean;
    isLoading: boolean;
    saveErrorNonce: number;
    updateProfile: (updates: Partial<BelgianTaxProfile>) => void;
    resetProfile: () => void;
    setViewedYear: (year: number) => void;
    snapshotExistsForYear: (year: number) => boolean;
    profileForYear: (year: number) => BelgianTaxProfile;
    calculationForYear: (year: number) => BelgianTaxCalculation;
    displayCalculationForYear: (year: number) => BelgianTaxCalculation;
    createSnapshotFromLive: (year: number) => void;
    updateSnapshot: (year: number, updates: Partial<BelgianTaxProfile>) => void;
    metaForYear: (year: number) => BelgianTaxProfileSnapshotMeta | null;
    isYearFiled: (year: number) => boolean;
    getFrozenCalculation: (year: number) => BelgianTaxCalculation | null;
    getSnapshotHistory: (year: number) => SnapshotAuditEntry[];
    freezeCalculation: (year: number) => void;
    unfreezeCalculation: (year: number) => void;
    markYearAsFiled: (year: number, reference?: string) => void;
    unmarkYearAsFiled: (year: number) => void;
    _hydrate: (
        profile: BelgianTaxProfile,
        snapshots: BelgianTaxProfileSnapshots,
        metas: BelgianTaxProfileSnapshotMetas,
    ) => void;
    _beginHydration: () => void;
    _markSaveError: () => void;
}

export function resolveBelgianTaxProfile(
    state: Pick<BelgianTaxSlice, "profile" | "snapshots">,
    year: number,
): BelgianTaxProfile {
    if (year === state.profile.taxYear) return state.profile;
    return state.snapshots[year] ?? { ...state.profile, taxYear: year };
}

export function resolveBelgianTaxCalculation(
    state: Pick<BelgianTaxSlice, "profile" | "snapshots" | "snapshotMetas">,
    year: number,
): BelgianTaxCalculation {
    return (
        state.snapshotMetas[year]?.frozenCalculation ??
        computeBelgianPIT(resolveBelgianTaxProfile(state, year))
    );
}

export const createBelgianTaxSlice: StateCreator<
    SettingsStore,
    [],
    [],
    BelgianTaxSlice
> = (set, get) => ({
    profile: DEFAULT_BELGIAN_TAX_PROFILE,
    calculation: computeBelgianPIT(DEFAULT_BELGIAN_TAX_PROFILE),
    snapshots: {},
    snapshotMetas: {},
    viewedYear: DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
    isViewingHistorical: false,
    isLoading: true,
    saveErrorNonce: 0,

    updateProfile: (updates) =>
        set((state) => {
            const nextProfile = { ...state.profile, ...updates };
            const shouldArchive =
                nextProfile.taxYear > state.profile.taxYear &&
                !state.snapshots[state.profile.taxYear];
            if (!shouldArchive) {
                return {
                    profile: nextProfile,
                    calculation: computeBelgianPIT(nextProfile),
                    isViewingHistorical:
                        state.viewedYear !== nextProfile.taxYear,
                };
            }
            const year = state.profile.taxYear;
            return {
                profile: nextProfile,
                calculation: computeBelgianPIT(nextProfile),
                isViewingHistorical: state.viewedYear !== nextProfile.taxYear,
                snapshots: { ...state.snapshots, [year]: { ...state.profile } },
                snapshotMetas: appendHistoryEntry(
                    state.snapshotMetas,
                    year,
                    "created",
                ),
            };
        }),
    resetProfile: () =>
        set((state) => ({
            profile: DEFAULT_BELGIAN_TAX_PROFILE,
            calculation: computeBelgianPIT(DEFAULT_BELGIAN_TAX_PROFILE),
            isViewingHistorical:
                state.viewedYear !== DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
        })),
    setViewedYear: (viewedYear) =>
        set((state) => ({
            viewedYear,
            isViewingHistorical: viewedYear !== state.profile.taxYear,
        })),
    snapshotExistsForYear: (year) =>
        Object.prototype.hasOwnProperty.call(get().snapshots, year),
    profileForYear: (year) => resolveBelgianTaxProfile(get(), year),
    calculationForYear: (year) =>
        computeBelgianPIT(resolveBelgianTaxProfile(get(), year)),
    displayCalculationForYear: (year) =>
        resolveBelgianTaxCalculation(get(), year),
    createSnapshotFromLive: (year) =>
        set((state) => {
            if (state.snapshots[year]) return state;
            return {
                snapshots: {
                    ...state.snapshots,
                    [year]: { ...state.profile, taxYear: year },
                },
                snapshotMetas: appendHistoryEntry(
                    state.snapshotMetas,
                    year,
                    "created",
                ),
            };
        }),
    updateSnapshot: (year, updates) =>
        set((state) => {
            const existing = state.snapshots[year];
            if (!existing) return state;
            const { taxYear: _ignored, ...changes } = updates;
            void _ignored;
            return {
                snapshots: {
                    ...state.snapshots,
                    [year]: { ...existing, ...updates, taxYear: year },
                },
                snapshotMetas:
                    Object.keys(changes).length > 0
                        ? appendHistoryEntry(
                              state.snapshotMetas,
                              year,
                              "patched",
                              { changes },
                          )
                        : state.snapshotMetas,
            };
        }),
    metaForYear: (year) => get().snapshotMetas[year] ?? null,
    isYearFiled: (year) => !!get().snapshotMetas[year]?.filing,
    getFrozenCalculation: (year) =>
        get().snapshotMetas[year]?.frozenCalculation ?? null,
    getSnapshotHistory: (year) => get().snapshotMetas[year]?.history ?? [],
    freezeCalculation: (year) =>
        set((state) => ({
            snapshotMetas: appendHistoryEntry(
                {
                    ...state.snapshotMetas,
                    [year]: {
                        ...(state.snapshotMetas[year] ?? {}),
                        frozenCalculation: computeBelgianPIT(
                            resolveBelgianTaxProfile(state, year),
                        ),
                    },
                },
                year,
                "frozen",
            ),
        })),
    unfreezeCalculation: (year) =>
        set((state) => {
            const existing = state.snapshotMetas[year];
            if (!existing?.frozenCalculation) return state;
            const { frozenCalculation: _ignored, ...rest } = existing;
            void _ignored;
            return {
                snapshotMetas: appendHistoryEntry(
                    { ...state.snapshotMetas, [year]: rest },
                    year,
                    "unfrozen",
                ),
            };
        }),
    markYearAsFiled: (year, reference) =>
        set((state) => {
            const existing = state.snapshotMetas[year];
            const filing = {
                filedAt: new Date().toISOString(),
                ...(reference ? { reference } : {}),
            };
            return {
                snapshotMetas: appendHistoryEntry(
                    {
                        ...state.snapshotMetas,
                        [year]: {
                            ...(existing ?? {}),
                            filing,
                            frozenCalculation:
                                existing?.frozenCalculation ??
                                computeBelgianPIT(
                                    resolveBelgianTaxProfile(state, year),
                                ),
                        },
                    },
                    year,
                    "filed",
                    reference ? { reference } : undefined,
                ),
            };
        }),
    unmarkYearAsFiled: (year) =>
        set((state) => {
            const existing = state.snapshotMetas[year];
            if (!existing?.filing) return state;
            const { filing: _ignored, ...rest } = existing;
            void _ignored;
            return {
                snapshotMetas: appendHistoryEntry(
                    { ...state.snapshotMetas, [year]: rest },
                    year,
                    "unfiled",
                ),
            };
        }),
    _hydrate: (profile, snapshots, snapshotMetas) =>
        set({
            profile,
            calculation: computeBelgianPIT(profile),
            snapshots,
            snapshotMetas,
            viewedYear: profile.taxYear,
            isViewingHistorical: false,
            isLoading: false,
        }),
    _beginHydration: () =>
        set({
            profile: DEFAULT_BELGIAN_TAX_PROFILE,
            calculation: computeBelgianPIT(DEFAULT_BELGIAN_TAX_PROFILE),
            snapshots: {},
            snapshotMetas: {},
            viewedYear: DEFAULT_BELGIAN_TAX_PROFILE.taxYear,
            isViewingHistorical: false,
            isLoading: true,
            saveErrorNonce: 0,
        }),
    _markSaveError: () =>
        set((state) => ({ saveErrorNonce: state.saveErrorNonce + 1 })),
});
